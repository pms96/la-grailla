import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-stuck-test', role: 'ADMIN', email: 'admin-stuck@test.local' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
// Nunca la API real de Abacus.AI (coste y red): siempre el adaptador simulado.
vi.mock('@/lib/abacus-ai-adapter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abacus-ai-adapter')>('@/lib/abacus-ai-adapter');
  return { ...actual, getAbacusAIProvider: vi.fn(async () => new actual.MockAbacusAIAdapter()) };
});

await prisma.user.upsert({
  where: { id: 'admin-stuck-test' },
  update: {},
  create: { id: 'admin-stuck-test', email: 'admin-stuck-test@example.com', role: 'ADMIN' },
});

const { POST: generate } = await import('@/app/api/admin/sponsors-portal/[id]/generate/route');

// AUDIT: la generación reclama el sponsor (isGenerating = true) ANTES de llamar a la IA. Si la función serverless moría a mitad (límite
// de tiempo de Vercel), el `catch` nunca se ejecutaba y el sponsor quedaba "generando" para siempre, con un intento ya gastado y sin
// forma de reintentar desde el admin. Severidad: Alto (sponsor bloqueado; hay que tocar la BD a mano).
describe('Generación de vídeo IA — un claim colgado se recupera', () => {
  let requestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: { companyName: 'Atascado SL', contactName: 'Ada', email: `sponsor-stuck-${Date.now()}@example.com`, sponsorType: 'evento', status: 'ACCEPTED' },
    });
    requestId = request.id;
    const sponsor = await prisma.sponsor.create({
      data: { sponsorRequestId: request.id, status: 'LISTO_PARA_GENERAR', guidedAnswers: { estiloVisual: 'minimalista' }, freeText: 'Algo elegante' },
    });
    sponsorId = sponsor.id;
    const asset = await prisma.sponsorAsset.create({
      data: { sponsorId, url: 'https://test-store.public.blob.vercel-storage.com/logo.png', fileType: 'image/png', fileName: 'logo.png', fileSize: 100 },
    });
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { currentAssetId: asset.id } });
  });

  afterAll(async () => {
    await prisma.promptGenerationLog.deleteMany({ where: { sponsorId } });
    await prisma.sponsorVideoPrompt.deleteMany({ where: { sponsorId } });
    await prisma.sponsor.updateMany({ where: { id: sponsorId }, data: { currentAssetId: null } });
    await prisma.sponsorAsset.deleteMany({ where: { sponsorId } });
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: requestId } });
  });

  /** Deja el sponsor "generando" desde hace `minutes` minutos (updatedAt se fija a mano: Prisma lo reescribiría en un update normal). */
  async function stuckSince(minutes: number) {
    await prisma.$executeRaw`UPDATE "Sponsor" SET "isGenerating" = true, "generationCount" = 1, "status" = 'LISTO_PARA_GENERAR', "updatedAt" = ${new Date(Date.now() - minutes * 60_000)} WHERE id = ${sponsorId}`;
  }
  const call = () => generate(new Request('http://localhost', { method: 'POST' }), { params: { id: sponsorId } });

  it('una generación en curso hace pocos segundos sigue bloqueando (409)', async () => {
    await stuckSince(0.5);
    expect((await call()).status).toBe(409);
  });

  it('una generación "en curso" desde hace 10 minutos se considera muerta y se puede reintentar', async () => {
    await stuckSince(10);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await prisma.sponsor.findUnique({ where: { id: sponsorId } }))?.isGenerating).toBe(false);
  });
});
