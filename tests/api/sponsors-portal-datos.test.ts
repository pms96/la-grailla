import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

  it('rechaza sin token', async () => {
    const res = await saveDatos(
      jsonRequest('http://localhost', { companyName: 'X', contactName: 'Y', sponsorType: 'evento' }),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(401);
  });

  it('permite guardar sin email (solo completa nombre/contacto/tipo)', async () => {
    const res = await saveDatos(
      jsonRequest(`http://localhost?t=${token}`, { companyName: 'Datos Incompletos SL', contactName: 'Rocío Actualizada', sponsorType: 'espacio' }),
      { params: { sponsorId } }
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
      { params: { sponsorId } }
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
      { params: { sponsorId } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sponsorRequest.email).toBe('rocio@example.com');
    expect(data.sponsorRequest.phone).toBe('34600123456');

    const after = await prisma.sponsorRequest.findUnique({ where: { id: sponsorRequestId } });
    expect(after?.consentAt).not.toBeNull();

    const portalRes = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
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
      { params: { sponsorId } }
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
      { params: { sponsorId } }
    );
    expect(res.status).toBe(400);
  });

  it('rechaza si la solicitud ya está cerrada', async () => {
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'RECHAZADO' } });
    const res = await saveDatos(
      jsonRequest(`http://localhost?t=${token}`, { companyName: 'X', contactName: 'Y', sponsorType: 'evento' }),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(409);
  });
});
