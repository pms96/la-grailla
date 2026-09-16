import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-sponsors-put-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { PUT: updateSponsorLead } = await import('@/app/api/admin/sponsors/[id]/route');

function putRequest(body: unknown): Request {
  return new Request('http://localhost', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// AUDIT: el tipo de patrocinio ya no se recoge en el formulario público — el
// admin debe poder asignarlo (o cambiarlo) después desde /admin/sponsors/[id].
describe('PUT /api/admin/sponsors/[id] — asignar tipo de patrocinio', () => {
  let requestId: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Asignar Tipo SL',
        contactName: 'Bruno',
        email: 'asignar-tipo-test@example.com',
        status: 'PENDING',
        // sponsorType queda sin asignar a propósito
      },
    });
    requestId = request.id;
  });

  afterAll(async () => {
    await prisma.sponsorRequest.deleteMany({ where: { id: requestId } });
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = null;
    const res = await updateSponsorLead(putRequest({ sponsorType: 'evento' }), { params: { id: requestId } });
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('empieza sin tipo asignado', async () => {
    const lead = await prisma.sponsorRequest.findUnique({ where: { id: requestId } });
    expect(lead?.sponsorType).toBeNull();
  });

  it('permite al admin asignar el tipo de patrocinio', async () => {
    const res = await updateSponsorLead(putRequest({ sponsorType: 'espacio' }), { params: { id: requestId } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sponsorType).toBe('espacio');

    const lead = await prisma.sponsorRequest.findUnique({ where: { id: requestId } });
    expect(lead?.sponsorType).toBe('espacio');
  });

  it('permite cambiarlo más tarde', async () => {
    const res = await updateSponsorLead(putRequest({ sponsorType: 'ambos' }), { params: { id: requestId } });
    expect(res.status).toBe(200);
    const lead = await prisma.sponsorRequest.findUnique({ where: { id: requestId } });
    expect(lead?.sponsorType).toBe('ambos');
  });
});
