import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';

const delMock = vi.fn(async (_url: string) => undefined);
vi.mock('@vercel/blob', () => ({
  del: (url: string) => delMock(url),
}));

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => null),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { DELETE: deleteAsset } = await import('@/app/api/sponsors/portal/[sponsorId]/assets/[assetId]/route');
const { signSponsorAccess } = await import('@/lib/access-token');

function deleteRequest(token?: string): Request {
  const url = token ? `http://localhost?t=${token}` : 'http://localhost';
  return new Request(url, { method: 'DELETE' });
}

// AUDIT: el sponsor no tenía forma de quitar un archivo subido por error
// (formato equivocado, logo antiguo...) desde su propio portal — solo podía
// añadir más, acumulando materiales incorrectos que confundían la revisión.
describe('DELETE /api/sponsors/portal/[sponsorId]/assets/[assetId]', () => {
  let sponsorRequestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Portal Assets Delete SL',
        contactName: 'Titular Portal',
        email: `sponsor-portal-assets-delete-test-${Date.now()}@example.com`,
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

  it('rechaza sin token de acceso válido', async () => {
    const asset = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/sin-token.png', fileType: 'image/png', fileName: 'sin-token.png', fileSize: 10 },
    });
    const res = await deleteAsset(deleteRequest(), { params: { sponsorId, assetId: asset.id } });
    expect(res.status).toBe(401);
    await prisma.sponsorAsset.delete({ where: { id: asset.id } });
  });

  it('con token válido, borra el archivo (fila + blob)', async () => {
    delMock.mockClear();
    const sponsor = await prisma.sponsor.findUniqueOrThrow({ where: { id: sponsorId } });
    const token = signSponsorAccess(sponsorId, sponsor.portalTokenVersion);
    const asset = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/con-token.png', fileType: 'image/png', fileName: 'con-token.png', fileSize: 10 },
    });

    const res = await deleteAsset(deleteRequest(token), { params: { sponsorId, assetId: asset.id } });
    expect(res.status).toBe(200);
    expect(delMock).toHaveBeenCalledWith('https://blob.test/con-token.png');

    const found = await prisma.sponsorAsset.findUnique({ where: { id: asset.id } });
    expect(found).toBeNull();
  });

  it('rechaza borrar un archivo de otro sponsor aunque el token sea válido para este', async () => {
    const otherRequest = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Otro Sponsor SL',
        contactName: 'Otro',
        email: `sponsor-otro-assets-delete-test-${Date.now()}@example.com`,
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    const otherSponsor = await prisma.sponsor.create({ data: { sponsorRequestId: otherRequest.id } });
    const otherAsset = await prisma.sponsorAsset.create({
      data: { sponsorId: otherSponsor.id, url: 'https://blob.test/otro.png', fileType: 'image/png', fileName: 'otro.png', fileSize: 10 },
    });

    const sponsor = await prisma.sponsor.findUniqueOrThrow({ where: { id: sponsorId } });
    const token = signSponsorAccess(sponsorId, sponsor.portalTokenVersion);
    const res = await deleteAsset(deleteRequest(token), { params: { sponsorId, assetId: otherAsset.id } });
    expect(res.status).toBe(404);

    await prisma.sponsorAsset.deleteMany({ where: { id: otherAsset.id } });
    await prisma.sponsor.deleteMany({ where: { id: otherSponsor.id } });
    await prisma.sponsorRequest.deleteMany({ where: { id: otherRequest.id } });
  });

  // AUDIT: mismo criterio que editar (logo/datos/creatividad) — una vez
  // aprobado o rechazado, la solicitud está cerrada y no se debe poder tocar.
  it('rechaza borrar si la solicitud ya está cerrada (aprobada o rechazada)', async () => {
    const closedSponsor = await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'APROBADO_PARA_VIDEO' } });
    const asset = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/cerrado.png', fileType: 'image/png', fileName: 'cerrado.png', fileSize: 10 },
    });
    const token = signSponsorAccess(sponsorId, closedSponsor.portalTokenVersion);

    const res = await deleteAsset(deleteRequest(token), { params: { sponsorId, assetId: asset.id } });
    expect(res.status).toBe(409);

    await prisma.sponsorAsset.delete({ where: { id: asset.id } });
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'PENDIENTE_MATERIALES' } });
  });
});
