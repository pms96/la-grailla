import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';

const delMock = vi.fn(async (_url: string) => undefined);
vi.mock('@vercel/blob', () => ({
  del: (url: string) => delMock(url),
}));

// El binario ya no pasa por nuestras rutas — el navegador lo sube
// directamente a Vercel Blob usando un token que emite upload-token/route.ts.
// Aquí se simula esa llamada invocando directamente el `onBeforeGenerateToken`
// que le pasamos, igual que haría el SDK real.
vi.mock('@vercel/blob/client', () => ({
  handleUpload: vi.fn(async ({ body, onBeforeGenerateToken }: any) => {
    const { pathname, clientPayload, multipart } = body.payload;
    const options = await onBeforeGenerateToken(pathname, clientPayload ?? null, multipart ?? false);
    return { type: 'blob.generate-client-token', clientToken: 'fake-client-token', ...options };
  }),
}));

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-final-video-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: uploadFinalVideo, DELETE: deleteFinalVideo } = await import('@/app/api/admin/sponsors-portal/[id]/final-video/route');
const { POST: getUploadToken } = await import('@/app/api/admin/sponsors-portal/[id]/final-video/upload-token/route');
const { GET: getSponsorPortal } = await import('@/app/api/sponsors/portal/[sponsorId]/route');
const { signSponsorAccess } = await import('@/lib/access-token');

function tokenRequest(pathname: string): Request {
  return new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'blob.generate-client-token', payload: { pathname, multipart: false, clientPayload: null } }),
  });
}

function confirmRequest(file: { url: string; fileName: string; fileSize: number }): Request {
  return new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(file),
  });
}

describe('POST /api/admin/sponsors-portal/[id]/final-video/upload-token', () => {
  let sponsorRequestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Final Video Token SL',
        contactName: 'Titular Token',
        email: 'sponsor-final-video-token-test@example.com',
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
    const res = await getUploadToken(tokenRequest(`sponsors/${sponsorId}/final-video/x.mp4`), { params: { id: sponsorId } });
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  // AUDIT: el pathname lo elige el cliente antes de pedir el token — sin
  // esta comprobación, se podría pedir un token válido para escribir en la
  // carpeta de vídeo final de OTRO sponsor.
  it('rechaza un pathname fuera de la carpeta de este sponsor', async () => {
    const res = await getUploadToken(tokenRequest(`sponsors/otro-sponsor-id/final-video/x.mp4`), { params: { id: sponsorId } });
    expect(res.status).toBe(500);
  });

  it('emite un token con formatos ampliados y tamaño máximo mayor que el de referencia', async () => {
    const res = await getUploadToken(tokenRequest(`sponsors/${sponsorId}/final-video/x.mp4`), { params: { id: sponsorId } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.allowedContentTypes).toEqual(expect.arrayContaining(['video/mp4', 'video/x-matroska', 'video/x-msvideo']));
    expect(data.maximumSizeInBytes).toBe(200 * 1024 * 1024);
  });
});

describe('POST/DELETE /api/admin/sponsors-portal/[id]/final-video (confirmación tras subir a Blob)', () => {
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
    const res = await uploadFinalVideo(
      confirmRequest({ url: `https://blob.test/sponsors/${sponsorId}/final-video/final.mp4`, fileName: 'final.mp4', fileSize: 123 }),
      { params: { id: sponsorId } }
    );
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('rechaza una URL que no pertenece a este sponsor', async () => {
    const res = await uploadFinalVideo(
      confirmRequest({ url: `https://blob.test/sponsors/otro-sponsor-id/final-video/final.mp4`, fileName: 'final.mp4', fileSize: 123 }),
      { params: { id: sponsorId } }
    );
    expect(res.status).toBe(400);
  });

  // AUDIT: el vídeo final no debe verse en el portal público del sponsor
  // hasta que la solicitud esté formalmente aprobada — si no, el sponsor
  // vería el archivo mientras el admin todavía lo está revisando/subiendo.
  it('confirma el vídeo pero el portal público no lo expone hasta estar aprobado', async () => {
    const res = await uploadFinalVideo(
      confirmRequest({ url: `https://blob.test/sponsors/${sponsorId}/final-video/final.mp4`, fileName: 'final.mp4', fileSize: 123 }),
      { params: { id: sponsorId } }
    );
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
    const res = await uploadFinalVideo(
      confirmRequest({ url: `https://blob.test/sponsors/${sponsorId}/final-video/final-v2.mp4`, fileName: 'final-v2.mp4', fileSize: 456 }),
      { params: { id: sponsorId } }
    );
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
