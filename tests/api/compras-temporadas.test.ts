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
      { params: { id: temporada.id } }
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
      { params: { id: temporada.id } }
    );
    const listado = await getTemporadas(new Request('http://localhost'));
    const data = await listado.json();
    expect(data.find((t: { id: string }) => t.id === temporada.id)).toBeDefined();
  });
});
