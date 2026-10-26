import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => null) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: getSponsorPortal } = await import('@/app/api/sponsors/portal/[sponsorId]/route');

// AUDIT: el portal del sponsor aceptaba cualquier sesión de staff, también la de TAQUILLA, sin token. Un taquillero podía leer y
// editar los materiales de cualquier sponsor. Además devolvía la fila entera del sponsor: brandContext (la investigación privada del
// admin), errores de envío de email y contadores internos de generación. Severidad: Alto.
describe('Portal del sponsor — quién entra y qué ve', () => {
  let sponsorRequestId: string;
  let sponsorId: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: { companyName: 'Roles SL', contactName: 'Titular Roles', email: 'sponsor-roles-test@example.com', sponsorType: 'evento', status: 'ACCEPTED' },
    });
    sponsorRequestId = request.id;
    const sponsor = await prisma.sponsor.create({
      data: {
        sponsorRequestId,
        brandContext: 'INVESTIGACION PRIVADA del admin — no debe verse en el portal',
        invitationEmailStatus: 'FAILED',
        invitationEmailError: 'smtp: credenciales rechazadas',
        isCollaboration: true,
        generationCount: 2,
      },
    });
    sponsorId = sponsor.id;
  });

  afterAll(async () => {
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: sponsorRequestId } });
  });

  const call = () => getSponsorPortal(new Request('http://localhost'), { params: Promise.resolve({ sponsorId }) });
  const asRole = (role: string | null) =>
    vi.mocked(getServerSession).mockResolvedValue((role ? { user: { id: 'u-test', role } } : null) as never);

  it('una sesión de TAQUILLA sin token no entra al portal', async () => {
    asRole('TAQUILLA');
    expect((await call()).status).toBe(401);
  });

  it('un anónimo sin token no entra', async () => {
    asRole(null);
    expect((await call()).status).toBe(401);
  });

  it('un admin sin token sí entra', async () => {
    asRole('ADMIN');
    expect((await call()).status).toBe(200);
  });

  it('el portal solo devuelve lo que la pantalla del sponsor necesita', async () => {
    asRole('ADMIN');
    const data = (await (await call()).json()) as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain('INVESTIGACION PRIVADA');
    for (const key of ['brandContext', 'invitationEmailStatus', 'invitationEmailError', 'invitationSentAt', 'isCollaboration', 'generationCount', 'maxGenerations', 'isGenerating', 'portalTokenVersion', 'sponsorRequestId']) {
      expect(data[key], key).toBeUndefined();
    }
    expect(Object.keys(data).sort()).toEqual(
      ['assets', 'currentAsset', 'finalVideo', 'freeText', 'guidedAnswers', 'id', 'isPaid', 'sponsorRequest', 'status'].sort()
    );
  });
});
