import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';

const putMock = vi.fn(async (key: string) => ({ url: `https://blob.test/${key}` }));
const delMock = vi.fn(async (_url: string) => undefined);
vi.mock('@vercel/blob', () => ({
  put: (key: string) => putMock(key),
  del: (url: string) => delMock(url),
}));

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-final-video-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: uploadFinalVideo, DELETE: deleteFinalVideo } = await import('@/app/api/admin/sponsors-portal/[id]/final-video/route');
const { GET: getSponsorPortal } = await import('@/app/api/sponsors/portal/[sponsorId]/route');
const { signSponsorAccess } = await import('@/lib/access-token');

function multipartRequest(file: File): Request {
  const formData = new FormData();
  formData.append('file', file);
  return new Request('http://localhost', { method: 'POST', body: formData });
}

describe('POST/DELETE /api/admin/sponsors-portal/[id]/final-video', () => {
  let sponsorRequestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Final Video SL',
        contactName: 'Titular Video',
        email: 'sponsor-final-video-test@example.com',
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    sponsorRequestId = request.id;
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId } });
    sponsorId = sponsor.id;
  });

  afterAll(async () => {
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: sponsorRequestId } });
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = null;
    const file = new File([new Uint8Array([1, 2, 3])], 'final.mp4', { type: 'video/mp4' });
    const res = await uploadFinalVideo(multipartRequest(file), { params: { id: sponsorId } });
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('rechaza un tipo de archivo no permitido', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'final.exe', { type: 'application/x-msdownload' });
    const res = await uploadFinalVideo(multipartRequest(file), { params: { id: sponsorId } });
    expect(res.status).toBe(400);
  });

  // AUDIT: el vídeo final no debe verse en el portal público del sponsor
  // hasta que la solicitud esté formalmente aprobada — si no, el sponsor
  // vería el archivo mientras el admin todavía lo está revisando/subiendo.
  it('sube el vídeo pero el portal público no lo expone hasta estar aprobado', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'final.mp4', { type: 'video/mp4' });
    const res = await uploadFinalVideo(multipartRequest(file), { params: { id: sponsorId } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.finalVideoUrl).toContain('https://blob.test/');
    expect(data.finalVideoFileName).toBe('final.mp4');

    const token = signSponsorAccess(sponsorId, data.portalTokenVersion);
    const portalRes = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const portalData = await portalRes.json();
    expect(portalData.finalVideo).toBeNull();
  });

  it('el portal público expone el vídeo una vez aprobado', async () => {
    const sponsor = await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'APROBADO_PARA_VIDEO' } });
    const token = signSponsorAccess(sponsorId, sponsor.portalTokenVersion);
    const portalRes = await getSponsorPortal(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const portalData = await portalRes.json();
    expect(portalData.finalVideo?.url).toContain('https://blob.test/');
    expect(portalData.finalVideo?.fileName).toBe('final.mp4');
  });

  it('reemplazar el vídeo borra el blob anterior', async () => {
    delMock.mockClear();
    const file = new File([new Uint8Array([9, 9, 9])], 'final-v2.mp4', { type: 'video/mp4' });
    const res = await uploadFinalVideo(multipartRequest(file), { params: { id: sponsorId } });
    expect(res.status).toBe(200);
    expect(delMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.finalVideoFileName).toBe('final-v2.mp4');
  });

  it('elimina el vídeo final', async () => {
    delMock.mockClear();
    const res = await deleteFinalVideo(new Request('http://localhost', { method: 'DELETE' }), { params: { id: sponsorId } });
    expect(res.status).toBe(200);
    expect(delMock).toHaveBeenCalledTimes(1);
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.finalVideoUrl).toBeNull();
  });
});
