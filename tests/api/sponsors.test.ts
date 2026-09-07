import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/prisma';

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
    await prisma.rateLimitBucket.deleteMany({ where: { key: `sponsors:${TEST_IP}` } });
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
    expect(adminCall.html).toContain('&lt;script&gt;alert("xss")&lt;/script&gt;Hola');

    expect(confirmCall.to).toBe('sponsor-html-test@example.com');
    expect(confirmCall.html).not.toContain('<b>Ana</b>');
    expect(confirmCall.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');

    await prisma.sponsorRequest.deleteMany({ where: { email: 'sponsor-html-test@example.com' } });
  });
});
