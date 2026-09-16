import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { signSponsorAccess } from '@/lib/access-token';

const { GET: getSponsorPortal } = await import('@/app/api/sponsors/portal/[sponsorId]/route');

describe('GET /api/sponsors/portal/[sponsorId] — datos expuestos', () => {
  let sponsorRequestId: string;
  let sponsorId: string;
  let token: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Portal Datos SL',
        contactName: 'Titular Datos',
        email: 'sponsor-portal-datos-test@example.com',
        sponsorType: 'evento',
        status: 'ACCEPTED',
        adminNotes: 'Cliente conflictivo, ojo con el pago — NO debe verse en el portal',
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

  // AUDIT: el portal devolvía sponsorRequest completo (include: true), lo que
  // filtraba adminNotes (notas internas del equipo, nunca pensadas para el
  // sponsor) a quien solo tiene el token público del portal.
  it('no expone adminNotes ni otros campos de gestión interna', async () => {
    const res = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const data = await res.json();
    expect(data.sponsorRequest.adminNotes).toBeUndefined();
    expect(data.sponsorRequest.temporadaId).toBeUndefined();
    expect(data.sponsorRequest.status).toBeUndefined();
  });

  it('expone el tipo de patrocinio elegido', async () => {
    const res = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const data = await res.json();
    expect(data.sponsorRequest.companyName).toBe('Portal Datos SL');
    expect(data.sponsorRequest.sponsorType).toBe('evento');
  });
});
