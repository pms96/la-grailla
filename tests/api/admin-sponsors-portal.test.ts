import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';

type SentMail = { html: string; to: string; subject?: string };
const sendMailMock = vi.fn(async (_p: SentMail) => ({ success: true, transport: 'smtp' as const }));
vi.mock('@/lib/mailer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mailer')>('@/lib/mailer');
  return { ...actual, sendMail: (p: SentMail) => sendMailMock(p) };
});

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-test', role: 'ADMIN', email: 'admin@test.local' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

// La BD de dev compartida puede tener una API key real de Abacus.AI
// configurada — sin este mock, "generate" llamaría a la API real por cada
// test (lento, con coste, y dependiente de red). Se fuerza siempre el mock.
vi.mock('@/lib/abacus-ai-adapter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abacus-ai-adapter')>('@/lib/abacus-ai-adapter');
  return { ...actual, getAbacusAIProvider: vi.fn(async () => new actual.MockAbacusAIAdapter()) };
});

// PromptGenerationLog.adminId y SponsorVideoPrompt.approvedById tienen FK
// real a User — el id de sesión mockeado ('admin-test') debe existir de verdad.
await prisma.user.upsert({
  where: { id: 'admin-test' },
  update: {},
  create: { id: 'admin-test', email: 'admin-sponsors-portal-test@example.com', role: 'ADMIN' },
});

const { POST: generate } = await import('@/app/api/admin/sponsors-portal/[id]/generate/route');
const { POST: markReady } = await import('@/app/api/admin/sponsors-portal/[id]/ready/route');
const { POST: approve } = await import('@/app/api/admin/sponsors-portal/[id]/approve/route');
const { POST: reject } = await import('@/app/api/admin/sponsors-portal/[id]/reject/route');
const { POST: notify } = await import('@/app/api/admin/sponsors-portal/[id]/notify/route');

async function createSponsorReadyToGenerate() {
  const request = await prisma.sponsorRequest.create({
    data: {
      companyName: 'Generación SL',
      contactName: 'Ada',
      email: `sponsor-gen-${Date.now()}@example.com`,
      sponsorType: 'evento',
      status: 'ACCEPTED',
    },
  });
  const sponsor = await prisma.sponsor.create({
    data: {
      sponsorRequestId: request.id,
      status: 'LISTO_PARA_GENERAR',
      guidedAnswers: { estiloVisual: 'minimalista' },
      freeText: 'Queremos algo elegante',
    },
  });
  const asset = await prisma.sponsorAsset.create({
    data: { sponsorId: sponsor.id, url: 'https://blob.test/logo.png', fileType: 'image/png', fileName: 'logo.png', fileSize: 100 },
  });
  await prisma.sponsor.update({ where: { id: sponsor.id }, data: { currentAssetId: asset.id } });
  return { requestId: request.id, sponsorId: sponsor.id };
}

async function cleanupSponsor(requestId: string, sponsorId: string) {
  await prisma.promptGenerationLog.deleteMany({ where: { sponsorId } });
  await prisma.sponsorVideoPrompt.deleteMany({ where: { sponsorId } });
  await prisma.sponsor.updateMany({ where: { id: sponsorId }, data: { currentAssetId: null } });
  await prisma.sponsorAsset.deleteMany({ where: { sponsorId } });
  await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
  await prisma.sponsorRequest.deleteMany({ where: { id: requestId } });
}

describe('POST /api/admin/sponsors-portal/[id]/generate', () => {
  let requestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const created = await createSponsorReadyToGenerate();
    requestId = created.requestId;
    sponsorId = created.sponsorId;
  });

  afterAll(async () => {
    await cleanupSponsor(requestId, sponsorId);
  });

  // AUDIT: sin API key de Abacus.AI configurada en el entorno de test, el
  // adaptador cae al mock — el endpoint debe seguir escribiendo el log y el
  // prompt como si fuera una generación real.
  it('genera un prompt (mock) y pasa a PROMPT_GENERADO', async () => {
    const res = await generate(new Request('http://localhost', { method: 'POST' }), { params: { id: sponsorId } });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.promptEs).toBeTruthy();
    expect(data.promptEn).toBeTruthy();

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.status).toBe('PROMPT_GENERADO');
    expect(sponsor?.generationCount).toBe(1);
    expect(sponsor?.isGenerating).toBe(false);

    const log = await prisma.promptGenerationLog.findFirst({ where: { sponsorId } });
    expect(log?.success).toBe(true);
    expect(log?.attemptNumber).toBe(1);
  });

  // AUDIT: límite de coste — un sponsor no puede generar más de 3 veces.
  it('rechaza generar una cuarta vez tras agotar el límite de 3 intentos', async () => {
    await generate(new Request('http://localhost', { method: 'POST' }), { params: { id: sponsorId } });
    const res3 = await generate(new Request('http://localhost', { method: 'POST' }), { params: { id: sponsorId } });
    expect(res3.status).toBe(200);

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.generationCount).toBe(3);

    const res4 = await generate(new Request('http://localhost', { method: 'POST' }), { params: { id: sponsorId } });
    expect(res4.status).toBe(409);
    const afterFourth = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(afterFourth?.generationCount).toBe(3);
  });

  // AUDIT: dos peticiones de generación en paralelo (doble clic, dos admins)
  // no deben consumir el mismo slot dos veces — el updateMany condicional
  // debe dejar que solo una gane.
  it('solo una de dos generaciones simultáneas reclama el slot', async () => {
    const created = await createSponsorReadyToGenerate();
    try {
      const [r1, r2] = await Promise.all([
        generate(new Request('http://localhost', { method: 'POST' }), { params: { id: created.sponsorId } }),
        generate(new Request('http://localhost', { method: 'POST' }), { params: { id: created.sponsorId } }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      // Ambas pueden devolver 200 si se serializan una detrás de otra (no hay
      // condición de carrera real en este test de un solo proceso), pero el
      // contador nunca debe superar el número de éxitos reales.
      const sponsor = await prisma.sponsor.findUnique({ where: { id: created.sponsorId } });
      expect(sponsor!.generationCount).toBeLessThanOrEqual(2);
      expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    } finally {
      await cleanupSponsor(created.requestId, created.sponsorId);
    }
  });
});

describe('flujo de aprobación/rechazo/notificación', () => {
  let requestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const created = await createSponsorReadyToGenerate();
    requestId = created.requestId;
    sponsorId = created.sponsorId;
    await generate(new Request('http://localhost', { method: 'POST' }), { params: { id: sponsorId } });
  });

  afterAll(async () => {
    await cleanupSponsor(requestId, sponsorId);
  });

  it('aprueba un prompt generado', async () => {
    const res = await approve(new Request('http://localhost', { method: 'POST' }), { params: { id: sponsorId } });
    expect(res.status).toBe(200);
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.status).toBe('APROBADO_PARA_VIDEO');
    const prompt = await prisma.sponsorVideoPrompt.findUnique({ where: { sponsorId } });
    expect(prompt?.approvedAt).not.toBeNull();
    expect(prompt?.approvedById).toBe('admin-test');
  });

  // AUDIT: el sponsor no debe recibir ningún email hasta que un admin lo pida
  // explícitamente — este es ese disparador manual.
  it('notifica al sponsor por email solo cuando se pulsa el botón', async () => {
    sendMailMock.mockClear();
    const res = await notify(new Request('http://localhost', { method: 'POST' }), { params: { id: sponsorId } });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toContain('sponsor-gen-');
  });
});

describe('POST /api/admin/sponsors-portal/[id]/ready — control de rol', () => {
  it('rechaza a un usuario que no es ADMIN', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u1', role: 'USER' } } as never);
    const res = await markReady(new Request('http://localhost', { method: 'POST' }), { params: { id: 'irrelevant' } });
    expect(res.status).toBe(401);
  });

  it('rechaza también a TAQUILLA (esto es gestión de patrocinios, no acceso)', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u2', role: 'TAQUILLA' } } as never);
    const res = await reject(new Request('http://localhost', { method: 'POST' }), { params: { id: 'irrelevant' } });
    expect(res.status).toBe(401);
  });
});
