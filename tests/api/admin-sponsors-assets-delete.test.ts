import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';

const delMock = vi.fn(async (_url: string) => undefined);
vi.mock('@vercel/blob', () => ({
  del: (url: string) => delMock(url),
}));

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-assets-delete-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { DELETE: deleteAsset } = await import('@/app/api/admin/sponsors-portal/[id]/assets/[assetId]/route');

function deleteRequest(): Request {
  return new Request('http://localhost', { method: 'DELETE' });
}

// AUDIT: los materiales de sponsor eran "append-only" a propósito (nunca se
// borraban), pero eso dejaba sin forma de limpiar un archivo subido por
// error — ni el admin ni el propio sponsor podían quitarlo.
describe('DELETE /api/admin/sponsors-portal/[id]/assets/[assetId]', () => {
  let sponsorRequestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Assets Delete SL',
        contactName: 'Titular Assets',
        email: `sponsor-assets-delete-test-${Date.now()}@example.com`,
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
    const asset = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/x.png', fileType: 'image/png', fileName: 'x.png', fileSize: 10 },
    });
    sessionRole = null;
    const res = await deleteAsset(deleteRequest(), { params: { id: sponsorId, assetId: asset.id } });
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
    await prisma.sponsorAsset.delete({ where: { id: asset.id } });
  });

  it('devuelve 404 si el archivo no existe o no pertenece a este sponsor', async () => {
    const res = await deleteAsset(deleteRequest(), { params: { id: sponsorId, assetId: 'no-existe' } });
    expect(res.status).toBe(404);
  });

  it('borra el archivo (fila + blob) que no es el vigente', async () => {
    delMock.mockClear();
    const asset = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/no-vigente.png', fileType: 'image/png', fileName: 'no-vigente.png', fileSize: 10 },
    });

    const res = await deleteAsset(deleteRequest(), { params: { id: sponsorId, assetId: asset.id } });
    expect(res.status).toBe(200);
    expect(delMock).toHaveBeenCalledWith('https://blob.test/no-vigente.png');

    const found = await prisma.sponsorAsset.findUnique({ where: { id: asset.id } });
    expect(found).toBeNull();
  });

  it('al borrar la imagen vigente, repunta automáticamente a la más reciente que quede', async () => {
    const older = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/older.png', fileType: 'image/png', fileName: 'older.png', fileSize: 10, uploadedAt: new Date(Date.now() - 60_000) },
    });
    const current = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/current.png', fileType: 'image/png', fileName: 'current.png', fileSize: 10 },
    });
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { currentAssetId: current.id } });

    const res = await deleteAsset(deleteRequest(), { params: { id: sponsorId, assetId: current.id } });
    expect(res.status).toBe(200);

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.currentAssetId).toBe(older.id);

    await prisma.sponsorAsset.deleteMany({ where: { id: older.id } });
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { currentAssetId: null } });
  });

  it('al borrar la única imagen vigente sin ninguna otra imagen, se queda sin vigente', async () => {
    const onlyOne = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://blob.test/only.png', fileType: 'image/png', fileName: 'only.png', fileSize: 10 },
    });
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { currentAssetId: onlyOne.id } });

    const res = await deleteAsset(deleteRequest(), { params: { id: sponsorId, assetId: onlyOne.id } });
    expect(res.status).toBe(200);

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.currentAssetId).toBeNull();
  });
});
