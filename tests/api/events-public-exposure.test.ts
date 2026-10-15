import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getServerSession } from 'next-auth';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => null) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: listEvents } = await import('@/app/api/events/route');
const { GET: getEvent } = await import('@/app/api/events/[slug]/route');

// AUDIT: la API pública listaba borradores (?status=DRAFT) y devolvía la fila entera del evento, con datos internos de gestión
// (umbrales y avisos de aforo, vínculo con la temporada de Contabilidad). Severidad: Alto (fuga de eventos sin publicar).
describe('API pública de eventos — borradores y campos internos', () => {
  let draft: Awaited<ReturnType<typeof createTestEvent>>;
  let published: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    draft = await createTestEvent({ status: 'DRAFT' });
    published = await createTestEvent({ status: 'PUBLISHED' });
  });

  afterAll(async () => {
    await cleanupTestEvent(draft.id);
    await cleanupTestEvent(published.id);
  });

  const asAnonymous = () => vi.mocked(getServerSession).mockResolvedValue(null as never);
  const asRole = (role: string) => vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'u-test', role } } as never);

  it('?status=DRAFT sin sesión no lista borradores', async () => {
    asAnonymous();
    const res = await listEvents(new Request('http://localhost/api/events?status=DRAFT'));
    const data = (await res.json()) as { id: string }[];
    expect(data.find((e) => e.id === draft.id)).toBeUndefined();
  });

  it('?status=DRAFT con una sesión de taquilla tampoco lista borradores', async () => {
    asRole('TAQUILLA');
    const res = await listEvents(new Request('http://localhost/api/events?status=DRAFT'));
    const data = (await res.json()) as { id: string }[];
    expect(data.find((e) => e.id === draft.id)).toBeUndefined();
  });

  it('?status=DRAFT con un admin sí lista borradores', async () => {
    asRole('ADMIN');
    const res = await listEvents(new Request('http://localhost/api/events?status=DRAFT'));
    const data = (await res.json()) as { id: string }[];
    expect(data.find((e) => e.id === draft.id)).toBeDefined();
  });

  it('el listado sin filtro no incluye borradores (regresión)', async () => {
    asAnonymous();
    const res = await listEvents(new Request('http://localhost/api/events'));
    const data = (await res.json()) as { id: string }[];
    expect(data.find((e) => e.id === draft.id)).toBeUndefined();
    expect(data.find((e) => e.id === published.id)).toBeDefined();
  });

  it('el detalle de un borrador da 404 a un anónimo y 200 a un admin', async () => {
    asAnonymous();
    const anon = await getEvent(new Request('http://localhost'), { params: { slug: draft.slug } });
    expect(anon.status).toBe(404);

    asRole('ADMIN');
    const admin = await getEvent(new Request('http://localhost'), { params: { slug: draft.slug } });
    expect(admin.status).toBe(200);
  });

  it('el listado y el detalle públicos no devuelven campos internos de gestión', async () => {
    asAnonymous();
    const list = (await (await listEvents(new Request('http://localhost/api/events'))).json()) as Record<string, unknown>[];
    const fromList = list.find((e) => e.id === published.id)!;
    const detail = (await (await getEvent(new Request('http://localhost'), { params: { slug: published.slug } })).json()) as Record<string, unknown>;
    for (const body of [fromList, detail]) {
      for (const key of ['alertsSent', 'alertThresholds', 'alertAt80', 'alertAt95', 'temporadaId', 'archivado']) {
        expect(body[key], key).toBeUndefined();
      }
      // Lo que la web sí necesita sigue ahí.
      expect(body.name).toBe(published.name);
      expect(body.slug).toBe(published.slug);
    }
  });
});
