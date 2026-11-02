import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { signSponsorAccess } from '@/lib/access-token';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => null),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: saveDatos } = await import('@/app/api/sponsors/portal/[sponsorId]/datos/route');
const { GET: getSponsorPortal } = await import('@/app/api/sponsors/portal/[sponsorId]/route');

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// AUDIT: un sponsor dado de alta sin email debe poder completar sus propios
// datos (incluido el email) desde el portal — es la otra mitad de la
// funcionalidad "alta manual sin email": alguien tiene que poder rellenarlo.
describe('POST /api/sponsors/portal/[sponsorId]/datos', () => {
  let sponsorRequestId: string;
  let sponsorId: string;
  let token: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Datos Incompletos SL',
        contactName: 'Rocío',
        sponsorType: 'evento',
        status: 'ACCEPTED',
        // sin email a propósito — el mismo caso que la alta manual sin email
      },
    });
    sponsorRequestId = request.id;
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId } });
    sponsorId = sponsor.id;
    token = signSponsorAccess(sponsorId, sponsor.portalTokenVersion);
  });

  afterAll(async () => {
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: sponsorRequestId } });
  });

  // H-169 (fase 5) y H-216 (ronda 2): la web del sponsor acaba en un `href` del panel del admin. Esta ruta (solo con el token del sponsor) la guardaba tal cual (`javascript:`
  // en la BD) y al validarla el formulario del portal, que NO tiene campo web pero reenviaba la guardada, daba 400 a quien tenía una web antigua no válida y le impedía guardar
  // su email y el consentimiento. El portal no edita la web: la ignora (la fijan el alta pública, validada, y el admin).
  describe('website: el portal no la escribe (H-169, H-216)', () => {
    const save = (website: unknown) =>
      saveDatos(jsonRequest(`http://localhost?t=${token}`, { companyName: 'Datos Incompletos SL', contactName: 'Rocío', website }), { params: Promise.resolve({ sponsorId }) });
    const stored = async () => (await prisma.sponsorRequest.findUnique({ where: { id: sponsorRequestId }, select: { website: true } }))?.website ?? null;

    afterEach(async () => {
      await prisma.sponsorRequest.update({ where: { id: sponsorRequestId }, data: { website: null } });
    });

    it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://nueva-web.com', '   '])('lo que llegue en `website` («%s») se ignora: 200 y la web guardada no cambia', async (sent) => {
      await prisma.sponsorRequest.update({ where: { id: sponsorRequestId }, data: { website: 'https://original.com' } });
      const res = await save(sent);
      expect(res.status).toBe(200);
      expect(await stored()).toBe('https://original.com');
      expect((await res.json()).sponsorRequest.website).toBe('https://original.com');
    });

    it('una web antigua NO válida ya guardada («instagram @empresa») no impide guardar los datos y se queda como estaba', async () => {
      await prisma.sponsorRequest.update({ where: { id: sponsorRequestId }, data: { website: 'instagram @empresa' } });
      const res = await save('instagram @empresa'); // lo que reenvía el formulario del portal al precargarla
      expect(res.status).toBe(200);
      expect(await stored()).toBe('instagram @empresa');
    });
  });

  it('rechaza sin token', async () => {
    const res = await saveDatos(
      jsonRequest('http://localhost', { companyName: 'X', contactName: 'Y', sponsorType: 'evento' }),
      { params: Promise.resolve({ sponsorId }) }
    );
    expect(res.status).toBe(401);
  });

  it('permite guardar sin email (solo completa nombre/contacto/tipo)', async () => {
    const res = await saveDatos(
      jsonRequest(`http://localhost?t=${token}`, { companyName: 'Datos Incompletos SL', contactName: 'Rocío Actualizada', sponsorType: 'espacio' }),
      { params: Promise.resolve({ sponsorId }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sponsorRequest.contactName).toBe('Rocío Actualizada');
    expect(data.sponsorRequest.email).toBeNull();
  });

  // AUDIT: la primera vez que se aporta un email (dato personal nuevo) exige
  // el mismo consentimiento RGPD que el formulario público — sin esto, un
  // sponsor podría acabar con su email guardado sin haber dado consentimiento.
  it('exige aceptar la política de privacidad la primera vez que se aporta un email', async () => {
    const res = await saveDatos(
      jsonRequest(`http://localhost?t=${token}`, {
        companyName: 'Datos Incompletos SL',
        contactName: 'Rocío',
        sponsorType: 'evento',
        email: 'rocio@example.com',
      }),
      { params: Promise.resolve({ sponsorId }) }
    );
    expect(res.status).toBe(400);

    const stillNull = await prisma.sponsorRequest.findUnique({ where: { id: sponsorRequestId } });
    expect(stillNull?.email).toBeNull();
  });

  it('guarda el email cuando se acepta el consentimiento, y registra consentAt', async () => {
    const before = await prisma.sponsorRequest.findUnique({ where: { id: sponsorRequestId } });
    expect(before?.consentAt).toBeNull();

    const res = await saveDatos(
      jsonRequest(`http://localhost?t=${token}`, {
        companyName: 'Datos Incompletos SL',
        contactName: 'Rocío',
        sponsorType: 'evento',
        email: 'rocio@example.com',
        phone: '600123456',
        consentAccepted: true,
      }),
      { params: Promise.resolve({ sponsorId }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sponsorRequest.email).toBe('rocio@example.com');
    expect(data.sponsorRequest.phone).toBe('34600123456');

    const after = await prisma.sponsorRequest.findUnique({ where: { id: sponsorRequestId } });
    expect(after?.consentAt).not.toBeNull();

    const portalRes = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: Promise.resolve({ sponsorId }) });
    const portalData = await portalRes.json();
    expect(portalData.sponsorRequest.email).toBe('rocio@example.com');
  });

  it('editar de nuevo tras haber dado consentimiento no lo vuelve a exigir', async () => {
    const res = await saveDatos(
      jsonRequest(`http://localhost?t=${token}`, {
        companyName: 'Datos Incompletos SL',
        contactName: 'Rocío',
        sponsorType: 'evento',
        email: 'rocio@example.com',
        message: 'Actualizo mi mensaje',
      }),
      { params: Promise.resolve({ sponsorId }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sponsorRequest.message).toBe('Actualizo mi mensaje');
  });

  it('rechaza un email con formato inválido', async () => {
    const res = await saveDatos(
      jsonRequest(`http://localhost?t=${token}`, {
        companyName: 'Datos Incompletos SL',
        contactName: 'Rocío',
        sponsorType: 'evento',
        email: 'no-es-un-email',
      }),
      { params: Promise.resolve({ sponsorId }) }
    );
    expect(res.status).toBe(400);
  });

  it('rechaza si la solicitud ya está cerrada', async () => {
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'RECHAZADO' } });
    const res = await saveDatos(
      jsonRequest(`http://localhost?t=${token}`, { companyName: 'X', contactName: 'Y', sponsorType: 'evento' }),
      { params: Promise.resolve({ sponsorId }) }
    );
    expect(res.status).toBe(409);
  });
});
