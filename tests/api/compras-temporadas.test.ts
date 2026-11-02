import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'admin-temporadas-test', role: 'ADMIN' } })),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: getTemporadas } = await import('@/app/api/admin/compras/temporadas/route');
const { PATCH: patchTemporada } = await import('@/app/api/admin/compras/temporadas/[id]/route');

// Fase 4 del plan de actuación: archivar una temporada es reversible (nunca
// un borrado) y la oculta del listado por defecto.
describe('GET/PATCH /api/admin/compras/temporadas — archivado (Fase 4)', () => {
  let temporada: Awaited<ReturnType<typeof prisma.temporada.create>>;

  beforeAll(async () => {
    temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada archivado', anio: 2096 } });
  });

  afterAll(async () => {
    await prisma.temporada.delete({ where: { id: temporada.id } }).catch(() => {});
  });

  it('PATCH archivado:true la oculta del listado por defecto y no la borra', async () => {
    const patched = await patchTemporada(
      new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivado: true }) }),
      { params: Promise.resolve({ id: temporada.id }) }
    );
    expect((await patched.json()).archivado).toBe(true);

    const listado = await getTemporadas(new Request('http://localhost'));
    const data = await listado.json();
    expect(data.find((t: { id: string }) => t.id === temporada.id)).toBeUndefined();

    const stillExists = await prisma.temporada.findUnique({ where: { id: temporada.id } });
    expect(stillExists).not.toBeNull();
  });

  it('?incluirArchivados=1 la vuelve a mostrar', async () => {
    const listado = await getTemporadas(new Request('http://localhost?incluirArchivados=1'));
    const data = await listado.json();
    const found = data.find((t: { id: string }) => t.id === temporada.id);
    expect(found).toBeDefined();
    expect(found.archivado).toBe(true);
  });

  it('PATCH archivado:false la restaura al listado por defecto', async () => {
    await patchTemporada(
      new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivado: false }) }),
      { params: Promise.resolve({ id: temporada.id }) }
    );
    const listado = await getTemporadas(new Request('http://localhost'));
    const data = await listado.json();
    expect(data.find((t: { id: string }) => t.id === temporada.id)).toBeDefined();
  });
});

// H-246: las fechas de la temporada se leían con `new Date(texto)` sin validar: «abc» daba un 500 (y una fecha con hora se guardaba como un instante que no es medianoche UTC). Ahora son días
// contables (`YYYY-MM-DD`) validados como en gastos e ingresos: texto inválido = 400.
describe('POST/PATCH /api/admin/compras/temporadas — fechas válidas (H-246)', () => {
  const crear = async (extra: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/admin/compras/temporadas/route');
    return POST(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: '[TEST] Temporada fechas', anio: 2095, ...extra }) }));
  };
  afterAll(async () => {
    await prisma.temporada.deleteMany({ where: { nombre: '[TEST] Temporada fechas' } });
  });

  it.each(['abc', '2026-13-45', '25/09/2026', '2026-09-25T10:30:00+02:00'])('crear con fechaInicio «%s» da 400 (no 500) y no crea nada', async (mala) => {
    const res = await crear({ fechaInicio: mala });
    expect(res.status).toBe(400);
    expect(await prisma.temporada.count({ where: { nombre: '[TEST] Temporada fechas' } })).toBe(0);
  });

  it('un día válido se guarda a medianoche UTC; vacío o nulo = sin fecha', async () => {
    const res = await crear({ fechaInicio: '2026-09-25', fechaFin: '' });
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(t.fechaInicio).toBe('2026-09-25T00:00:00.000Z');
    expect(t.fechaFin).toBeNull();
    const patch = await patchTemporada(
      new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fechaFin: 'no-es-fecha' }) }),
      { params: Promise.resolve({ id: t.id }) }
    );
    expect(patch.status).toBe(400);
  });
});
