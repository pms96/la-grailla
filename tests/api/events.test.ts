import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-events-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: getEvents, POST: createEvent } = await import('@/app/api/admin/events/route');
const { PATCH: patchEvent, PUT: putEvent } = await import('@/app/api/admin/events/[id]/route');

// Fase 0 del plan de actuación (auditoría UX Pedidos & Gastos): vínculo
// opcional Event.temporadaId + archivado, sin backfill automático.
describe('GET/PATCH /api/admin/events — vínculo con Temporada (Fase 0)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;
  let temporada: Awaited<ReturnType<typeof prisma.temporada.create>>;

  beforeAll(async () => {
    event = await createTestEvent();
    temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada eventos', anio: 2099 } });
  });

  afterAll(async () => {
    await cleanupTestEvent(event.id);
    await prisma.temporada.delete({ where: { id: temporada.id } }).catch(() => {});
  });

  it('un evento sin temporadaId se sigue creando y listando igual que antes (regresión)', async () => {
    const res = await getEvents(new Request('http://localhost'));
    expect(res.status).toBe(200);
    const data = await res.json();
    const found = data.find((e: { id: string }) => e.id === event.id);
    expect(found).toBeDefined();
    expect(found.temporadaId).toBeNull();
    expect(found.temporada).toBeNull();
    expect(found.archivado).toBe(false);
  });

  it('PATCH enlaza el evento a una temporada y GET la devuelve incluida', async () => {
    const res = await patchEvent(
      new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temporadaId: temporada.id }) }),
      { params: Promise.resolve({ id: event.id }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.temporadaId).toBe(temporada.id);

    const listado = await getEvents(new Request('http://localhost'));
    const found = (await listado.json()).find((e: { id: string }) => e.id === event.id);
    expect(found.temporada).toEqual({ id: temporada.id, nombre: temporada.nombre });
  });

  it('PATCH con temporadaId: null desenlaza el evento', async () => {
    const res = await patchEvent(
      new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temporadaId: null }) }),
      { params: Promise.resolve({ id: event.id }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.temporadaId).toBeNull();
  });

  it('PATCH archivado marca y desmarca el evento como archivado', async () => {
    const marcado = await patchEvent(
      new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivado: true }) }),
      { params: Promise.resolve({ id: event.id }) }
    );
    expect((await marcado.json()).archivado).toBe(true);

    const desmarcado = await patchEvent(
      new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivado: false }) }),
      { params: Promise.resolve({ id: event.id }) }
    );
    expect((await desmarcado.json()).archivado).toBe(false);
  });

  it('rechaza a un usuario que no es ADMIN', async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u1', role: 'TAQUILLA' } } as never);
    const res = await patchEvent(
      new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivado: true }) }),
      { params: Promise.resolve({ id: event.id }) }
    );
    expect(res.status).toBe(401);
  });
});

// Fase 2 del plan de actuación: el vínculo también se puede fijar desde el
// propio diálogo de crear/editar evento (POST/PUT), no solo con PATCH.
describe('POST/PUT /api/admin/events — enlace con Temporada desde el formulario (Fase 2)', () => {
  let temporada: Awaited<ReturnType<typeof prisma.temporada.create>>;

  beforeAll(async () => {
    temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada eventos 2', anio: 2098 } });
  });

  afterAll(async () => {
    await prisma.temporada.delete({ where: { id: temporada.id } }).catch(() => {});
  });

  it('POST crea el evento ya enlazado a la temporada indicada', async () => {
    const res = await createEvent(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '[TEST] Evento enlazado al crear', date: new Date().toISOString(), temporadaId: temporada.id }),
      })
    );
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.temporadaId).toBe(temporada.id);
    await cleanupTestEvent(created.id);
  });

  it('PUT actualiza el vínculo del evento (enlazar y desenlazar) en la edición completa', async () => {
    const event = await createTestEvent();
    try {
      const enlazado = await putEvent(
        new Request('http://localhost', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ temporadaId: temporada.id }),
        }),
        { params: Promise.resolve({ id: event.id }) }
      );
      expect((await enlazado.json()).temporadaId).toBe(temporada.id);

      const desenlazado = await putEvent(
        new Request('http://localhost', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ temporadaId: null }),
        }),
        { params: Promise.resolve({ id: event.id }) }
      );
      expect((await desenlazado.json()).temporadaId).toBeNull();
    } finally {
      await cleanupTestEvent(event.id);
    }
  });
});

// Fase 4 del plan de actuación: un evento archivado desaparece del listado
// por defecto y solo vuelve a aparecer con ?incluirArchivados=1.
describe('GET /api/admin/events — filtro de archivado (Fase 4)', () => {
  let event: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    event = await createTestEvent();
    await prisma.event.update({ where: { id: event.id }, data: { archivado: true } });
  });

  afterAll(async () => { await cleanupTestEvent(event.id); });

  it('un evento archivado no aparece en el listado por defecto', async () => {
    const res = await getEvents(new Request('http://localhost'));
    const data = await res.json();
    expect(data.find((e: { id: string }) => e.id === event.id)).toBeUndefined();
  });

  it('un evento archivado sí aparece con ?incluirArchivados=1', async () => {
    const res = await getEvents(new Request('http://localhost?incluirArchivados=1'));
    const data = await res.json();
    const found = data.find((e: { id: string }) => e.id === event.id);
    expect(found).toBeDefined();
    expect(found.archivado).toBe(true);
  });
});

// P0-02 de la auditoría de lanzamiento: la hora tecleada en el admin (`datetime-local`, sin zona) es hora de Madrid, no UTC; con Z u offset se
// respeta tal cual (scripts, seeds). El servidor corre en UTC, así que sin esta conversión «23:30» se guardaba como 23:30Z (00:30/01:30 en Madrid).
describe('POST/PUT /api/admin/events — la hora del formulario es hora de Madrid', () => {
  const json = (method: string, body: unknown) => new Request('http://localhost', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created: string[] = [];
  const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  afterAll(async () => { for (const id of created) await cleanupTestEvent(id); });

  const create = async (date: string) => {
    const res = await createEvent(json('POST', { name: `[TEST] Hora Madrid ${unique()}`, date }));
    const body = await res.json();
    if (body?.id) created.push(body.id);
    return { res, body };
  };

  it('POST sin zona (verano): 23:30 se guarda como 21:30Z', async () => {
    const { res, body } = await create('2026-07-15T23:30');
    expect(res.status).toBe(200);
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.date.toISOString()).toBe('2026-07-15T21:30:00.000Z');
  });

  it('POST sin zona (invierno, tras la medianoche): 00:30 se guarda como 23:30Z del día anterior', async () => {
    const { body } = await create('2026-12-31T00:30');
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.date.toISOString()).toBe('2026-12-30T23:30:00.000Z');
  });

  it('POST con Z o con offset respeta el instante (compatibilidad con scripts y seeds)', async () => {
    const conZ = await create('2026-07-15T21:00:00.000Z');
    expect((await prisma.event.findUniqueOrThrow({ where: { id: conZ.body.id } })).date.toISOString()).toBe('2026-07-15T21:00:00.000Z');
    const conOffset = await create('2026-07-15T23:00:00+02:00');
    expect((await prisma.event.findUniqueOrThrow({ where: { id: conOffset.body.id } })).date.toISOString()).toBe('2026-07-15T21:00:00.000Z');
  });

  it('POST con una fecha ilegible responde 400 en vez de romper con 500', async () => {
    const { res, body } = await create('mañana por la noche');
    expect(res.status).toBe(400);
    expect(body.error).toBe('Fecha y hora no válidas');
  });

  it('PUT sin zona se interpreta en Madrid; con Z se respeta; vacío o ausente no la toca; ilegible da 400', async () => {
    const event = await createTestEvent({ date: new Date('2026-07-18T21:00:00Z') });
    created.push(event.id);
    const put = (body: unknown) => putEvent(json('PUT', body), { params: Promise.resolve({ id: event.id }) });
    const dateOf = async () => (await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).date.toISOString();

    expect((await put({ date: '2026-12-31T23:30' })).status).toBe(200);
    expect(await dateOf()).toBe('2026-12-31T22:30:00.000Z');

    expect((await put({ date: '2026-07-18T21:00:00Z' })).status).toBe(200);
    expect(await dateOf()).toBe('2026-07-18T21:00:00.000Z');

    expect((await put({ date: '', name: '[TEST] Sin tocar la fecha' })).status).toBe(200);
    expect(await dateOf()).toBe('2026-07-18T21:00:00.000Z');

    expect((await put({ date: 'basura' })).status).toBe(400);
    expect(await dateOf()).toBe('2026-07-18T21:00:00.000Z');
  });
});
