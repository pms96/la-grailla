import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/prisma';
import { CAPTCHA_SECRET_KEY, CAPTCHA_SITE_KEY } from '@/lib/captcha';
import { getAndSetConfig, restoreConfig } from '../helpers/fixtures';

type SentMail = { html: string; to: string; subject?: string; replyTo?: string };

const sendMailMock = vi.fn(async (_params: SentMail) => ({ success: true, transport: 'smtp' as const }));

vi.mock('@/lib/mailer', () => ({
  sendMail: (params: SentMail) => sendMailMock(params),
}));

const { POST: createSponsorRequest } = await import('@/app/api/sponsors/route');

function sponsorRequest(body: unknown, ip: string) {
  return new Request('http://localhost/api/sponsors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

const TEST_IP = '203.0.113.30';

describe('POST /api/sponsors', () => {
  beforeEach(async () => {
    sendMailMock.mockClear();
    // POST /api/sponsors está limitado a 5 peticiones/hora por IP (real,
    // respaldado en Postgres — no es un limitador en memoria que se resetee
    // solo entre ejecuciones). Sin este borrado, más de 5 ejecuciones
    // seguidas de la suite dentro de la misma hora agotan el cupo de esta
    // IP fija y el test empieza a fallar con 429 en vez de 200.
    await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: `sponsors:${TEST_IP}` }, { key: { startsWith: 'sponsors-email:' } }] } });
  });

  // AUDIT: companyName/contactName/sponsorType/phone/message se interpolaban
  // sin escapar en el HTML de dos emails reales (al buzón del negocio y al
  // remitente) — cualquiera podía meter HTML/enlaces en "Mensaje". Severidad: Medio.
  it('escapa el HTML de los campos del formulario en los emails enviados', async () => {
    const res = await createSponsorRequest(
      sponsorRequest(
        {
          companyName: '<img src=x onerror=alert(1)>Acme',
          contactName: '<b>Ana</b>',
          email: 'sponsor-html-test@example.com',
          sponsorType: 'Stand',
          message: '<script>alert("xss")</script>Hola',
          consentAccepted: true,
        },
        TEST_IP
      )
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const [adminCall, confirmCall] = sendMailMock.mock.calls.map((c) => c[0]);

    expect(adminCall.to).toBe('grupolagrailla@gmail.com');
    expect(adminCall.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(adminCall.html).not.toContain('<script>');
    expect(adminCall.html).toContain('&lt;img src=x onerror=alert(1)&gt;Acme');
    expect(adminCall.html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;Hola');

    expect(confirmCall.to).toBe('sponsor-html-test@example.com');
    expect(confirmCall.html).not.toContain('<b>Ana</b>');
    expect(confirmCall.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');

    await prisma.sponsorRequest.deleteMany({ where: { email: 'sponsor-html-test@example.com' } });
  });

  // AUDIT: el tipo de patrocinio ya no se pide en el formulario público — lo
  // asigna el admin después desde /admin/sponsors/[id]. La solicitud debe
  // poder crearse igualmente, con sponsorType a null.
  it('crea la solicitud sin pedir tipo de patrocinio', async () => {
    const res = await createSponsorRequest(
      sponsorRequest(
        {
          companyName: 'Sin Tipo SL',
          contactName: 'Nora',
          email: 'sponsor-sin-tipo-test@example.com',
          consentAccepted: true,
        },
        TEST_IP
      )
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    const created = await prisma.sponsorRequest.findUnique({ where: { id: json.id } });
    expect(created?.sponsorType).toBeNull();

    await prisma.sponsorRequest.deleteMany({ where: { email: 'sponsor-sin-tipo-test@example.com' } });
  });

  // H-105: `website` iba tal cual a un `href` del correo al operador; la confirmación sale a CUALQUIER email con el nombre de contacto en la primera línea.
  describe('H-105: website, nombre de contacto, tope por destinatario y captcha', () => {
    const ok = (over: Record<string, unknown> = {}) => ({
      companyName: 'Acme',
      contactName: 'Nora',
      email: 'sponsor-h105-test@example.com',
      consentAccepted: true,
      ...over,
    });
    const cleanup = () => prisma.sponsorRequest.deleteMany({ where: { email: { startsWith: 'sponsor-h105' } } });
    // También al empezar: un test que falla antes de limpiar (o una ejecución cortada) dejaría filas que falsean el siguiente recuento.
    beforeEach(async () => {
      await cleanup();
    });

    it('un website con esquema peligroso, comillas o espacios se rechaza (400) y no crea nada ni manda correos', async () => {
      for (const website of ['javascript:alert(1)', 'https://x.es" onmouseover="alert(1)', "https://x.es' style='position:fixed'", 'data:text/html,hola', 'https://user:pass@evil.es']) {
        const res = await createSponsorRequest(sponsorRequest(ok({ website }), TEST_IP));
        expect(res.status, website).toBe(400);
      }
      expect(sendMailMock).not.toHaveBeenCalled();
      expect(await prisma.sponsorRequest.count({ where: { email: 'sponsor-h105-test@example.com' } })).toBe(0);
    });

    it('un website sin esquema se guarda normalizado y es lo único que llega al href del correo del operador', async () => {
      const res = await createSponsorRequest(sponsorRequest(ok({ website: 'instagram.com/acme' }), TEST_IP));
      expect(res.status).toBe(200);
      const saved = await prisma.sponsorRequest.findFirst({ where: { email: 'sponsor-h105-test@example.com' } });
      expect(saved?.website).toBe('https://instagram.com/acme');
      expect(sendMailMock.mock.calls[0][0].html).toContain('<a href="https://instagram.com/acme">');
      await cleanup();
    });

    it('un website vacío o solo espacios se guarda como nulo y el correo dice «No proporcionada»', async () => {
      const res = await createSponsorRequest(sponsorRequest(ok({ website: '   ' }), TEST_IP));
      expect(res.status).toBe(200);
      const saved = await prisma.sponsorRequest.findFirst({ where: { email: 'sponsor-h105-test@example.com' } });
      expect(saved?.website).toBeNull();
      expect(sendMailMock.mock.calls[0][0].html).toContain('No proporcionada');
      await cleanup();
    });

    it('el nombre de contacto no puede llevar enlaces ni direcciones (la confirmación va a un email ajeno), pero sí nombres normales', async () => {
      for (const contactName of ['Visita https://evil.es ahora', 'Gana premios en www.evil.es', 'ana@evil.es', 'escribe a juan@acme', 'Entra en evil.com']) {
        const res = await createSponsorRequest(sponsorRequest(ok({ contactName }), TEST_IP));
        expect(res.status, contactName).toBe(400);
      }
      expect(sendMailMock).not.toHaveBeenCalled();
      for (const [i, contactName] of ['Dr. Ruiz', 'María José Núñez-Ibáñez', "O'Brien"].entries()) {
        // Las solicitudes rechazadas de arriba también cuentan para el tope de 5 por hora de la IP: se limpia antes de cada una.
        await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: `sponsors:${TEST_IP}` }, { key: { startsWith: 'sponsors-email:' } }] } });
        const res = await createSponsorRequest(sponsorRequest(ok({ contactName, email: `sponsor-h105-ok${i}@example.com` }), TEST_IP));
        expect(res.status, contactName).toBe(200);
        await prisma.rateLimitBucket.deleteMany({ where: { key: `sponsors:${TEST_IP}` } });
      }
      await cleanup();
    });

    it('el nombre de contacto de más de 100 caracteres se rechaza', async () => {
      const res = await createSponsorRequest(sponsorRequest(ok({ contactName: 'a'.repeat(101) }), TEST_IP));
      expect(res.status).toBe(400);
    });

    it('un mismo destinatario recibe como mucho 3 solicitudes al día aunque cambie de IP (sin importar mayúsculas)', async () => {
      const ips = ['203.0.113.31', '203.0.113.32', '203.0.113.33', '203.0.113.34'];
      try {
        const statuses: number[] = [];
        for (const [i, ip] of ips.entries()) {
          await prisma.rateLimitBucket.deleteMany({ where: { key: `sponsors:${ip}` } });
          const email = i % 2 ? 'SPONSOR-H105-VICTIMA@example.com' : 'sponsor-h105-victima@example.com';
          const res = await createSponsorRequest(sponsorRequest(ok({ email }), ip));
          statuses.push(res.status);
          if (res.status === 429) expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
        expect(sendMailMock).toHaveBeenCalledTimes(6); // 3 solicitudes × (operador + confirmación); la cuarta no manda nada
      } finally {
        for (const ip of ips) await prisma.rateLimitBucket.deleteMany({ where: { key: `sponsors:${ip}` } });
        await cleanup();
      }
    });

    it('el tope por destinatario guarda el hash del email, no la dirección en claro', async () => {
      await createSponsorRequest(sponsorRequest(ok(), TEST_IP));
      const buckets = await prisma.rateLimitBucket.findMany({ where: { key: { startsWith: 'sponsors-email:' } } });
      expect(buckets.length).toBeGreaterThan(0);
      for (const b of buckets) expect(b.key).toMatch(/^sponsors-email:[0-9a-f]{64}$/);
      await cleanup();
    });

    describe('captcha (Turnstile) del cliente', () => {
      let origSite: string | null;
      let origSecret: string | null;
      beforeEach(async () => {
        origSite = await getAndSetConfig(CAPTCHA_SITE_KEY, '0x4AAAA-test-site');
        origSecret = await getAndSetConfig(CAPTCHA_SECRET_KEY, '0x4AAAA-test-secret');
      });
      afterEach(async () => {
        vi.restoreAllMocks();
        await restoreConfig(CAPTCHA_SITE_KEY, origSite);
        await restoreConfig(CAPTCHA_SECRET_KEY, origSecret);
      });
      const fakeSiteverify = (verdict: Record<string, unknown>) =>
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (!url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) throw new Error(`fetch inesperado: ${url}`);
          return new Response(JSON.stringify(verdict), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

      it('con el captcha activado, sin token: 400 captcha_required, sin solicitud ni correos', async () => {
        const res = await createSponsorRequest(sponsorRequest(ok(), TEST_IP));
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('captcha_required');
        expect(sendMailMock).not.toHaveBeenCalled();
        expect(await prisma.sponsorRequest.count({ where: { email: 'sponsor-h105-test@example.com' } })).toBe(0);
      });

      it('un token de otra acción (el del pedido) no vale: 400 captcha_failed', async () => {
        fakeSiteverify({ success: true, action: 'order' });
        const res = await createSponsorRequest(sponsorRequest(ok({ captchaToken: 'tok' }), TEST_IP));
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('captcha_failed');
        expect(sendMailMock).not.toHaveBeenCalled();
      });

      it('con un token de la acción `sponsor` se crea la solicitud y salen los dos correos', async () => {
        fakeSiteverify({ success: true, action: 'sponsor' });
        const res = await createSponsorRequest(sponsorRequest(ok({ captchaToken: 'tok' }), TEST_IP));
        expect(res.status).toBe(200);
        expect(sendMailMock).toHaveBeenCalledTimes(2);
        await cleanup();
      });

      it('un envío con captcha rechazado NO gasta el cupo por destinatario (la víctima no se queda sin avisos por culpa de un bot)', async () => {
        for (let i = 0; i < 5; i++) {
          await prisma.rateLimitBucket.deleteMany({ where: { key: `sponsors:${TEST_IP}` } });
          const res = await createSponsorRequest(sponsorRequest(ok(), TEST_IP));
          expect(res.status).toBe(400);
        }
        expect(await prisma.rateLimitBucket.count({ where: { key: { startsWith: 'sponsors-email:' } } })).toBe(0);
      });
    });
  });
});
