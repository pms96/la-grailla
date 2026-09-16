import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { verifySponsorAccess } from '@/lib/access-token';

type SentMail = { html: string; to: string; subject?: string };
type SendMailResult = { success: boolean; transport: 'smtp' | 'none'; error?: string };
const sendMailMock = vi.fn(async (_p: SentMail): Promise<SendMailResult> => ({ success: true, transport: 'smtp' }));
vi.mock('@/lib/mailer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mailer')>('@/lib/mailer');
  return { ...actual, sendMail: (p: SentMail) => sendMailMock(p) };
});

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-lifecycle-test', role: 'ADMIN', email: 'admin@test.local' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

await prisma.user.upsert({
  where: { id: 'admin-lifecycle-test' },
  update: {},
  create: { id: 'admin-lifecycle-test', email: 'admin-sponsors-lifecycle-test@example.com', role: 'ADMIN' },
});

const { POST: createSponsor } = await import('@/app/api/admin/sponsors/route');
const { POST: reject } = await import('@/app/api/admin/sponsors-portal/[id]/reject/route');
const { POST: resendInvite } = await import('@/app/api/admin/sponsors-portal/[id]/resend-invite/route');
const { POST: regenerateToken } = await import('@/app/api/admin/sponsors-portal/[id]/regenerate-token/route');

function adminRequest(body?: unknown) {
  return new Request('http://localhost', {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function cleanup(requestId: string, sponsorId: string | null) {
  if (sponsorId) {
    await prisma.sponsorEmailLog.deleteMany({ where: { sponsorId } });
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
  }
  await prisma.sponsorEmailLog.deleteMany({ where: { sponsorRequestId: requestId } });
  await prisma.sponsorRequest.deleteMany({ where: { id: requestId } });
}

describe('POST /api/admin/sponsors — alta manual', () => {
  // AUDIT: crear un sponsor manual con status ACCEPTED debe generar el
  // Sponsor y devolver el portalUrl en la misma respuesta, sin depender de
  // que el email de invitación llegue a enviarse.
  it('crea el SponsorRequest y el Sponsor, y devuelve el portalUrl aunque el email falle', async () => {
    sendMailMock.mockImplementationOnce(async () => ({ success: false, transport: 'none', error: 'SMTP caído' }));

    const res = await createSponsor(
      adminRequest({
        companyName: 'Alta Manual SL',
        contactName: 'Rosa',
        email: `manual-${Date.now()}@example.com`,
        phone: '600123456',
        sponsorType: 'evento',
        status: 'ACCEPTED',
      })
    );
    const data = await res.json();
    try {
      expect(res.status).toBe(201);
      expect(data.sponsor).toBeTruthy();
      expect(typeof data.portalUrl).toBe('string');
      expect(data.portalUrl).toContain('/sponsors/portal/');
      expect(data.invitationEmailSuccess).toBe(false);

      const sponsor = await prisma.sponsor.findUnique({ where: { id: data.sponsor.id } });
      expect(sponsor?.invitationEmailStatus).toBe('FAILED');
      expect(sponsor?.invitationEmailError).toBe('SMTP caído');
    } finally {
      await cleanup(data.sponsorRequest.id, data.sponsor?.id ?? null);
    }
  });

  it('teléfono se normaliza a solo dígitos con prefijo de país', async () => {
    const res = await createSponsor(
      adminRequest({
        companyName: 'Normaliza SL',
        contactName: 'Iker',
        email: `normaliza-${Date.now()}@example.com`,
        phone: '+34 600 12 34 56',
        sponsorType: 'evento',
        status: 'PENDING',
      })
    );
    const data = await res.json();
    try {
      expect(res.status).toBe(201);
      expect(data.sponsorRequest.phone).toBe('34600123456');
    } finally {
      await cleanup(data.sponsorRequest.id, null);
    }
  });
});

describe('rechazo, reenvío y regeneración de enlace', () => {
  let requestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const res = await createSponsor(
      adminRequest({
        companyName: 'Ciclo Vida SL',
        contactName: 'Marta',
        email: `ciclo-${Date.now()}@example.com`,
        sponsorType: 'evento',
        status: 'ACCEPTED',
      })
    );
    const data = await res.json();
    requestId = data.sponsorRequest.id;
    sponsorId = data.sponsor.id;
  });

  afterAll(async () => {
    await cleanup(requestId, sponsorId);
  });

  // AUDIT: rechazar ya no es silencioso — debe enviar el email de cortesía
  // automáticamente, sin depender de un segundo clic en "Notificar".
  it('rechazar envía el email automáticamente y lo registra en SponsorEmailLog', async () => {
    sendMailMock.mockClear();
    const res = await reject(adminRequest(), { params: { id: sponsorId } });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.rejectionEmailSuccess).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const log = await prisma.sponsorEmailLog.findFirst({ where: { sponsorId, type: 'REJECTION' } });
    expect(log?.success).toBe(true);

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.status).toBe('RECHAZADO');
  });

  it('rechazar un sponsor ya rechazado devuelve 409 (guarda de estado)', async () => {
    const res = await reject(adminRequest(), { params: { id: sponsorId } });
    expect(res.status).toBe(409);
  });

  it('reenviar invitación usa un tipo de email distinto de la invitación inicial', async () => {
    sendMailMock.mockClear();
    const res = await resendInvite(adminRequest(), { params: { id: sponsorId } });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    const log = await prisma.sponsorEmailLog.findFirst({
      where: { sponsorId, type: 'PORTAL_INVITE_RESEND' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log).toBeTruthy();
    expect(log?.sentById).toBe('admin-lifecycle-test');
  });

  // AUDIT: garantía central de la revocación individual — regenerar el
  // enlace debe invalidar cualquier token firmado con la versión anterior.
  it('regenerar el enlace invalida el token anterior', async () => {
    const before = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    const staleVersion = before!.portalTokenVersion;

    const res = await regenerateToken(adminRequest(), { params: { id: sponsorId } });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.portalUrl).toContain('/sponsors/portal/');

    const after = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(after!.portalTokenVersion).toBe(staleVersion + 1);

    const newToken = new URL(data.portalUrl).searchParams.get('t')!;
    expect(verifySponsorAccess(sponsorId, after!.portalTokenVersion, newToken)).toBe(true);
    expect(verifySponsorAccess(sponsorId, staleVersion, newToken)).toBe(false);
  });
});
