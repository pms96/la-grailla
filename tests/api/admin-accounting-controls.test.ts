import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

const ACTOR = 'acct-controls-test';
const ACTOR_EMAIL = 'acct-controls-test@example.com';
// undefined = propietario; un array = rol restringido por módulos (no puede anular ni cerrar).
let modules: string[] | undefined;
let role: 'ADMIN' | null = 'ADMIN';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (role ? { user: { id: ACTOR, email: ACTOR_EMAIL, role, modules } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: listGastos, POST: createGasto } = await import('@/app/api/admin/gastos/route');
const { PATCH: updateGasto, DELETE: voidGasto } = await import('@/app/api/admin/gastos/[id]/route');
const { POST: createIngreso } = await import('@/app/api/admin/ingresos/route');
const { PATCH: updateIngreso, DELETE: voidIngreso } = await import('@/app/api/admin/ingresos/[id]/route');
const { PATCH: patchTemporada } = await import('@/app/api/admin/compras/temporadas/[id]/route');
const { GET: resumenGastos } = await import('@/app/api/admin/gastos/resumen/route');
const { GET: resumenIngresos } = await import('@/app/api/admin/ingresos/resumen/route');
const { GET: listAuditoria } = await import('@/app/api/admin/auditoria/route');
const { getGastosParaExport } = await import('@/lib/gastos/gastos-data');

const json = (url: string, method: string, body?: unknown) =>
  new Request(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('P1-16 — controles de contabilidad: anulación, temporada cerrada y auditoría', () => {
  let temporadaId: string;

  const nuevoGasto = async (over: Record<string, unknown> = {}) => {
    const res = await createGasto(json('http://localhost', 'POST', { temporadaId, categoria: 'Bebida', concepto: '[TEST] Hielo', importeSinIva: 100, ivaPercent: 21, ...over }));
    return { res, body: await res.json() };
  };
  const auditoria = (where: Record<string, unknown>) => prisma.adminAuditLog.findMany({ where: { actorId: ACTOR, ...where }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await prisma.user.upsert({ where: { id: ACTOR }, update: {}, create: { id: ACTOR, email: ACTOR_EMAIL, role: 'ADMIN' } });
    temporadaId = (await prisma.temporada.create({ data: { nombre: '[TEST] Temporada controles', anio: 2096 } })).id;
  });

  afterAll(async () => {
    await prisma.gasto.deleteMany({ where: { temporadaId } });
    await prisma.ingreso.deleteMany({ where: { temporadaId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: ACTOR } });
    await prisma.temporada.delete({ where: { id: temporadaId } }).catch(() => {});
    await prisma.user.delete({ where: { id: ACTOR } }).catch(() => {});
  });

  describe('gastos', () => {
    it('crear y modificar un gasto deja su rastro: quién, qué y el cambio de → a', async () => {
      const { res, body } = await nuevoGasto({ concepto: '[TEST] Rastro' });
      expect(res.status).toBe(200);
      const [creado] = await auditoria({ action: 'gasto.create', targetId: body.id });
      expect(creado).toMatchObject({ actorEmail: ACTOR_EMAIL, targetType: 'Gasto' });
      expect(creado.meta).toMatchObject({ concepto: '[TEST] Rastro', temporadaId });

      const upd = await updateGasto(json('http://localhost', 'PATCH', { importeSinIva: 120 }), ctx(body.id));
      expect(upd.status).toBe(200);
      const [cambio] = await auditoria({ action: 'gasto.update', targetId: body.id });
      expect((cambio.meta as { cambios: Record<string, unknown> }).cambios).toEqual({ importeSinIva: { from: 100, to: 120 } });
    });

    it('un gasto en una temporada que no existe da 404, no un 500 de clave foránea', async () => {
      const { res } = await nuevoGasto({ temporadaId: 'no-existe' });
      expect(res.status).toBe(404);
    });

    it('anular exige ser propietario, y un rol restringido no toca nada', async () => {
      const { body } = await nuevoGasto({ concepto: '[TEST] Solo propietario' });
      modules = ['contabilidad'];
      try {
        const res = await voidGasto(json('http://localhost', 'DELETE', { motivo: 'Lo quiero fuera' }), ctx(body.id));
        expect(res.status).toBe(403);
      } finally {
        modules = undefined;
      }
      expect((await prisma.gasto.findUnique({ where: { id: body.id } }))?.voidedAt).toBeNull();
    });

    it('anular pide un motivo; con él, el gasto sigue en la BD pero fuera de listas, resumen y export', async () => {
      const fuera = (await nuevoGasto({ concepto: '[TEST] Se anula', importeSinIva: 100, ivaPercent: 0 })).body;
      const queda = (await nuevoGasto({ concepto: '[TEST] Se queda', importeSinIva: 50, ivaPercent: 0 })).body;
      const antes = await (await resumenGastos(new Request(`http://localhost?temporadaId=${temporadaId}`))).json();

      expect((await voidGasto(json('http://localhost', 'DELETE'), ctx(fuera.id))).status).toBe(400);
      expect((await voidGasto(json('http://localhost', 'DELETE', { motivo: 'xx' }), ctx(fuera.id))).status).toBe(400);
      const res = await voidGasto(json('http://localhost', 'DELETE', { motivo: 'Factura duplicada' }), ctx(fuera.id));
      expect(res.status).toBe(200);

      const fila = await prisma.gasto.findUnique({ where: { id: fuera.id } });
      expect(fila).toMatchObject({ voidReason: 'Factura duplicada', voidedById: ACTOR });
      expect(fila?.voidedAt).toBeInstanceOf(Date);

      const [rastro] = await auditoria({ action: 'gasto.void', targetId: fuera.id });
      expect(rastro.meta).toMatchObject({ motivo: 'Factura duplicada', concepto: '[TEST] Se anula', importeSinIva: 100 });

      const lista = await (await listGastos(new Request(`http://localhost/api/admin/gastos?temporadaId=${temporadaId}`))).json();
      const ids = lista.map((g: { id: string }) => g.id);
      expect(ids).toContain(queda.id);
      expect(ids).not.toContain(fuera.id);
      const conAnulados = await (await listGastos(new Request(`http://localhost/api/admin/gastos?temporadaId=${temporadaId}&anulados=1`))).json();
      expect(conAnulados.map((g: { id: string }) => g.id)).toContain(fuera.id);

      const despues = await (await resumenGastos(new Request(`http://localhost?temporadaId=${temporadaId}`))).json();
      expect(despues.gastoTotal).toBeCloseTo(antes.gastoTotal - 100, 2);

      const exportado = await getGastosParaExport(temporadaId);
      expect(exportado?.gastos.map((g) => g.concepto)).not.toContain('[TEST] Se anula');
    });

    it('un gasto anulado ya no se puede modificar ni anular otra vez (409)', async () => {
      const { body } = await nuevoGasto({ concepto: '[TEST] Ya anulado' });
      await voidGasto(json('http://localhost', 'DELETE', { motivo: 'Error de tecleo' }), ctx(body.id));
      expect((await updateGasto(json('http://localhost', 'PATCH', { concepto: 'otra cosa' }), ctx(body.id))).status).toBe(409);
      expect((await voidGasto(json('http://localhost', 'DELETE', { motivo: 'Otra vez más' }), ctx(body.id))).status).toBe(409);
    });
  });

  describe('ingresos', () => {
    it('anular un ingreso: solo propietario, con motivo, fuera de la caja y con rastro', async () => {
      const crear = async (importe: number) => (await (await createIngreso(json('http://localhost', 'POST', { temporadaId, concepto: '[TEST] Caja', importe, fecha: '2026-09-25' }))).json()) as { id: string };
      const a = await crear(200);
      const b = await crear(30);
      const antes = await (await resumenIngresos(new Request(`http://localhost?temporadaId=${temporadaId}`))).json();

      modules = ['contabilidad'];
      try {
        expect((await voidIngreso(json('http://localhost', 'DELETE', { motivo: 'No me corresponde' }), ctx(a.id))).status).toBe(403);
      } finally {
        modules = undefined;
      }
      expect((await voidIngreso(json('http://localhost', 'DELETE'), ctx(a.id))).status).toBe(400);
      expect((await voidIngreso(json('http://localhost', 'DELETE', { motivo: 'Contado dos veces' }), ctx(a.id))).status).toBe(200);

      const despues = await (await resumenIngresos(new Request(`http://localhost?temporadaId=${temporadaId}`))).json();
      expect(despues.ingresoTotal).toBeCloseTo(antes.ingresoTotal - 200, 2);
      const [rastro] = await auditoria({ action: 'ingreso.void', targetId: a.id });
      expect(rastro.meta).toMatchObject({ motivo: 'Contado dos veces', importe: 200 });

      expect((await updateIngreso(json('http://localhost', 'PATCH', { importe: 1 }), ctx(a.id))).status).toBe(409);
      expect((await updateIngreso(json('http://localhost', 'PATCH', { importe: 35 }), ctx(b.id))).status).toBe(200);
      const [cambio] = await auditoria({ action: 'ingreso.update', targetId: b.id });
      expect((cambio.meta as { cambios: Record<string, unknown> }).cambios).toEqual({ importe: { from: 30, to: 35 } });
    });
  });

  describe('temporada cerrada', () => {
    it('cerrarla es del propietario; al cerrarla queda quién y cuándo, y se registra', async () => {
      modules = ['contabilidad'];
      try {
        expect((await patchTemporada(json('http://localhost', 'PATCH', { status: 'CERRADA' }), ctx(temporadaId))).status).toBe(403);
      } finally {
        modules = undefined;
      }
      const res = await patchTemporada(json('http://localhost', 'PATCH', { status: 'CERRADA', motivo: 'IVA del trimestre presentado' }), ctx(temporadaId));
      expect(res.status).toBe(200);
      const t = await prisma.temporada.findUnique({ where: { id: temporadaId } });
      expect(t).toMatchObject({ status: 'CERRADA', closedById: ACTOR });
      expect(t?.closedAt).toBeInstanceOf(Date);
      const [rastro] = await auditoria({ action: 'temporada.close', targetId: temporadaId });
      expect(rastro.meta).toMatchObject({ motivo: 'IVA del trimestre presentado' });
    });

    it('cerrada: no admite altas, cambios ni anulaciones de gastos e ingresos (423)', async () => {
      const gasto = await prisma.gasto.create({ data: { temporadaId, categoria: 'Otros', concepto: '[TEST] Previo al cierre', importeSinIva: 10, ivaPercent: 0 } });
      const ingreso = await prisma.ingreso.create({ data: { temporadaId, concepto: '[TEST] Previo al cierre', importe: 10 } });

      const alta = await nuevoGasto();
      expect(alta.res.status).toBe(423);
      expect(alta.body.code).toBe('temporada_cerrada');
      expect((await createIngreso(json('http://localhost', 'POST', { temporadaId, concepto: 'x', importe: 1 }))).status).toBe(423);
      expect((await updateGasto(json('http://localhost', 'PATCH', { importeSinIva: 11 }), ctx(gasto.id))).status).toBe(423);
      expect((await voidGasto(json('http://localhost', 'DELETE', { motivo: 'Quiero borrarlo' }), ctx(gasto.id))).status).toBe(423);
      expect((await updateIngreso(json('http://localhost', 'PATCH', { importe: 11 }), ctx(ingreso.id))).status).toBe(423);
      expect((await voidIngreso(json('http://localhost', 'DELETE', { motivo: 'Quiero borrarlo' }), ctx(ingreso.id))).status).toBe(423);

      expect(await prisma.gasto.findUnique({ where: { id: gasto.id } })).toMatchObject({ voidedAt: null });
      expect(await prisma.ingreso.findUnique({ where: { id: ingreso.id } })).toMatchObject({ voidedAt: null });
    });

    it('cerrada: tampoco se cambian sus datos, pero sí se puede archivar', async () => {
      expect((await patchTemporada(json('http://localhost', 'PATCH', { nombre: 'Otro nombre' }), ctx(temporadaId))).status).toBe(423);
      expect((await patchTemporada(json('http://localhost', 'PATCH', { archivado: true }), ctx(temporadaId))).status).toBe(200);
      expect((await patchTemporada(json('http://localhost', 'PATCH', { archivado: false }), ctx(temporadaId))).status).toBe(200);
    });

    it('reabrirla es del propietario y exige motivo; después vuelve a admitir escrituras', async () => {
      modules = ['contabilidad'];
      try {
        expect((await patchTemporada(json('http://localhost', 'PATCH', { status: 'ABIERTA', motivo: 'Necesito corregir' }), ctx(temporadaId))).status).toBe(403);
      } finally {
        modules = undefined;
      }
      expect((await patchTemporada(json('http://localhost', 'PATCH', { status: 'ABIERTA' }), ctx(temporadaId))).status).toBe(400);
      expect((await prisma.temporada.findUnique({ where: { id: temporadaId } }))?.status).toBe('CERRADA');

      const res = await patchTemporada(json('http://localhost', 'PATCH', { status: 'ABIERTA', motivo: 'Falta una factura de proveedor' }), ctx(temporadaId));
      expect(res.status).toBe(200);
      expect(await prisma.temporada.findUnique({ where: { id: temporadaId } })).toMatchObject({ status: 'ABIERTA', closedAt: null, closedById: null });
      const [rastro] = await auditoria({ action: 'temporada.reopen', targetId: temporadaId });
      expect(rastro.meta).toMatchObject({ motivo: 'Falta una factura de proveedor' });

      expect((await nuevoGasto({ concepto: '[TEST] Tras reabrir' })).res.status).toBe(200);
    });
  });

  describe('GET /api/admin/auditoria', () => {
    it('solo el propietario la lee; un rol restringido (403) y sin sesión (401) no', async () => {
      modules = ['contabilidad'];
      try {
        expect((await listAuditoria(new Request('http://localhost/api/admin/auditoria'))).status).toBe(403);
      } finally {
        modules = undefined;
      }
      role = null;
      try {
        expect((await listAuditoria(new Request('http://localhost/api/admin/auditoria'))).status).toBe(401);
      } finally {
        role = 'ADMIN';
      }
    });

    it('filtra por acción y objetivo, y pagina con cursor', async () => {
      const anulaciones = await (await listAuditoria(new Request('http://localhost/api/admin/auditoria?accion=gasto.void&limit=200'))).json();
      expect(anulaciones.items.length).toBeGreaterThan(0);
      expect(anulaciones.items.every((r: { action: string }) => r.action === 'gasto.void')).toBe(true);

      const deTemporada = await (await listAuditoria(new Request(`http://localhost/api/admin/auditoria?objetivo=Temporada&id=${temporadaId}&limit=200`))).json();
      expect(deTemporada.items.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(['temporada.close', 'temporada.reopen']));

      const p1 = await (await listAuditoria(new Request('http://localhost/api/admin/auditoria?accion=gasto&limit=1'))).json();
      expect(p1.items).toHaveLength(1);
      expect(p1.nextCursor).toBe(p1.items[0].id);
      const p2 = await (await listAuditoria(new Request(`http://localhost/api/admin/auditoria?accion=gasto&limit=1&cursor=${p1.nextCursor}`))).json();
      expect(p2.items[0].id).not.toBe(p1.items[0].id);
    });
  });
});
