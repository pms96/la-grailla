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

// AUDIT: el portal exponía el prompt de vídeo generado por IA (texto interno
// pensado para producir el vídeo, no para que el sponsor lo lea) y mostraba
// el vídeo final en cuanto status=APROBADO_PARA_VIDEO sin comprobar si el
// sponsor había pagado. Severidad: Medio (fuga de info interna + entrega
// antes de cobrar).
describe('GET /api/sponsors/portal/[sponsorId] — vídeo final condicionado al pago', () => {
  let sponsorRequestId: string;
  let sponsorId: string;
  let token: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Portal Pago SL',
        contactName: 'Titular Pago',
        email: 'sponsor-portal-pago-test@example.com',
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    sponsorRequestId = request.id;
    const sponsor = await prisma.sponsor.create({
      data: {
        sponsorRequestId,
        status: 'APROBADO_PARA_VIDEO',
        finalVideoUrl: 'https://blob.test/final.mp4',
        finalVideoFileName: 'final.mp4',
      },
    });
    sponsorId = sponsor.id;
    await prisma.sponsorVideoPrompt.create({
      data: { sponsorId, promptEs: 'Texto interno del prompt — no debe verse', promptEn: 'Internal prompt text' },
    });
    token = signSponsorAccess(sponsorId, sponsor.portalTokenVersion);
  });

  afterAll(async () => {
    await prisma.sponsorVideoPrompt.deleteMany({ where: { sponsorId } });
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: sponsorRequestId } });
  });

  it('nunca expone el texto del prompt', async () => {
    const res = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const data = await res.json();
    expect(data.videoPrompt).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('Texto interno del prompt');
  });

  it('no muestra el vídeo final si no está marcado como pagado, aunque esté aprobado', async () => {
    const res = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const data = await res.json();
    expect(data.isPaid).toBe(false);
    expect(data.finalVideo).toBeNull();
  });

  it('muestra el vídeo final una vez marcado como pagado', async () => {
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { isPaid: true, paidAmount: 30, paidAt: new Date() } });
    const res = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const data = await res.json();
    expect(data.isPaid).toBe(true);
    expect(data.finalVideo?.url).toBe('https://blob.test/final.mp4');
    // El importe/fecha exactos del pago no son necesarios para el cliente.
    expect(data.paidAmount).toBeUndefined();
  });
});
