import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-mark-paid-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: markPaid } = await import('@/app/api/admin/sponsors-portal/[id]/mark-paid/route');

function postRequest(body: unknown): Request {
  return new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// AUDIT: el importe de patrocinio pagado no se registraba en ningún sitio —
// esta ruta lo toma del precio configurado del tipo de patrocinio asignado
// (no lo escribe el admin a mano), y no bloquea ninguna acción del pipeline.
describe('POST /api/admin/sponsors-portal/[id]/mark-paid', () => {
  let requestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    // No depender de lo que ya hubiera guardado en Configuración — se fija un
    // tipo con un importe conocido para que el test no dependa del estado
    // compartido de la BD de dev.
    await prisma.appConfig.upsert({
      where: { key: 'sponsor_tiers' },
      update: { value: JSON.stringify([{ value: 'evento', label: 'Evento', priceLabel: '30€', priceAmount: 30 }]) },
      create: { key: 'sponsor_tiers', value: JSON.stringify([{ value: 'evento', label: 'Evento', priceLabel: '30€', priceAmount: 30 }]) },
    });

    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Marcar Pagado SL',
        contactName: 'Pat',
        email: `sponsor-mark-paid-${Date.now()}@example.com`,
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    requestId = request.id;
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId: request.id } });
    sponsorId = sponsor.id;
  });

  afterAll(async () => {
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: requestId } });
    await prisma.appConfig.deleteMany({ where: { key: 'sponsor_tiers' } });
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = null;
    const res = await markPaid(postRequest({ paid: true }), { params: { id: sponsorId } });
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('rechaza marcar como pagado si no hay tipo de patrocinio asignado', async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Sin Tipo Pagado SL',
        contactName: 'Sin Tipo',
        email: `sponsor-sin-tipo-pagado-${Date.now()}@example.com`,
        status: 'ACCEPTED',
      },
    });
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId: request.id } });
    const res = await markPaid(postRequest({ paid: true }), { params: { id: sponsor.id } });
    expect(res.status).toBe(400);
    await prisma.sponsor.deleteMany({ where: { id: sponsor.id } });
    await prisma.sponsorRequest.deleteMany({ where: { id: request.id } });
  });

  it('marca como pagado tomando el importe del tipo de patrocinio asignado', async () => {
    const res = await markPaid(postRequest({ paid: true }), { params: { id: sponsorId } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isPaid).toBe(true);
    expect(data.paidAmount).toBe(30);
    expect(data.paidAt).toBeTruthy();
  });

  it('no bloquea ninguna acción del pipeline: el status se mantiene intacto', async () => {
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.status).toBe('PENDIENTE_MATERIALES');
  });

  it('se puede desmarcar el pago', async () => {
    const res = await markPaid(postRequest({ paid: false }), { params: { id: sponsorId } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isPaid).toBe(false);
    expect(data.paidAmount).toBeNull();
    expect(data.paidAt).toBeNull();
  });
});
