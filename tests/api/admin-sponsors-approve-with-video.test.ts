import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-approve-with-video-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: approveWithVideo } = await import('@/app/api/admin/sponsors-portal/[id]/approve-with-video/route');

function postRequest(): Request {
  return new Request('http://localhost', { method: 'POST' });
}

// AUDIT: un sponsor que solo dio un vídeo de referencia (sin ninguna imagen
// de logo) no puede pasar por /generate (Abacus.AI no tiene imagen que
// animar — ver generate/route.ts) ni por /approve (exige un
// SponsorVideoPrompt que nunca podrá existir). Este camino alternativo salta
// la generación por IA y usa el propio vídeo del sponsor como vídeo final.
describe('POST /api/admin/sponsors-portal/[id]/approve-with-video', () => {
  let requestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Solo Vídeo Aprobación SL',
        contactName: 'Vera',
        email: `sponsor-approve-video-${Date.now()}@example.com`,
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    requestId = request.id;
    const sponsor = await prisma.sponsor.create({
      data: { sponsorRequestId: request.id, status: 'LISTO_PARA_GENERAR' },
    });
    sponsorId = sponsor.id;
    await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/referencia.mp4', fileType: 'video/mp4', fileName: 'referencia.mp4', fileSize: 300 },
    });
  });

  afterAll(async () => {
    await prisma.sponsorAsset.deleteMany({ where: { sponsorId } });
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: requestId } });
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = null;
    const res = await approveWithVideo(postRequest(), { params: { id: sponsorId } });
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('rechaza si el sponsor no tiene ningún vídeo subido', async () => {
    const otherRequest = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Sin Vídeo SL',
        contactName: 'Sin Vídeo',
        email: `sponsor-no-video-${Date.now()}@example.com`,
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    const otherSponsor = await prisma.sponsor.create({
      data: { sponsorRequestId: otherRequest.id, status: 'LISTO_PARA_GENERAR' },
    });
    const res = await approveWithVideo(postRequest(), { params: { id: otherSponsor.id } });
    expect(res.status).toBe(400);
    await prisma.sponsor.deleteMany({ where: { id: otherSponsor.id } });
    await prisma.sponsorRequest.deleteMany({ where: { id: otherRequest.id } });
  });

  it('aprueba usando el vídeo del sponsor como vídeo final', async () => {
    const res = await approveWithVideo(postRequest(), { params: { id: sponsorId } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('APROBADO_PARA_VIDEO');
    expect(data.finalVideoUrl).toBe('https://blob.test/referencia.mp4');
    expect(data.finalVideoFileName).toBe('referencia.mp4');
  });

  it('rechaza si ya no está en un estado válido (ya aprobado)', async () => {
    const res = await approveWithVideo(postRequest(), { params: { id: sponsorId } });
    expect(res.status).toBe(409);
  });
});
