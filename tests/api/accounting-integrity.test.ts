import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { prisma } from '@/lib/prisma';
import { purgeAuditLog } from '../helpers/audit';

const ACTOR = 'accounting-integrity-test';
const ACTOR_EMAIL = 'accounting-integrity-test@example.com';
let role: 'ADMIN' | null = 'ADMIN';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (role ? { user: { id: ACTOR, email: ACTOR_EMAIL, role } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: createGasto } = await import('@/app/api/admin/gastos/route');
const { PATCH: updateGasto, DELETE: voidGasto } = await import('@/app/api/admin/gastos/[id]/route');
const { POST: createIngreso } = await import('@/app/api/admin/ingresos/route');
const { PATCH: updateIngreso, DELETE: voidIngreso } = await import('@/app/api/admin/ingresos/[id]/route');
const { PATCH: patchTemporada } = await import('@/app/api/admin/compras/temporadas/[id]/route');
const { GET: resumenIngresos } = await import('@/app/api/admin/ingresos/resumen/route');
const { GET: ventasPorDia } = await import('@/app/api/admin/stats/ventas-por-dia/route');
const { GET: exportGastos } = await import('@/app/api/admin/gastos/export/route');
const { POST: generarPedidos } = await import('@/app/api/admin/compras/pedidos/generar/route');

const json = (method: string, body?: unknown) =>
  new Request('http://localhost', { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('integridad contable (lote 4)', () => {
  let tid: string;
  const temporadas: string[] = [];
  const extras = { proveedores: [] as string[], articulos: [] as string[] };

  const nuevaTemporada = async (anio: number, nombre = '[TEST] Temporada integridad') => {
    const t = await prisma.temporada.create({ data: { nombre, anio } });
    temporadas.push(t.id);
    return t.id;
  };
  const gasto = (over: Record<string, unknown> = {}, temporadaId = tid) =>
    createGasto(json('POST', { temporadaId, categoria: 'Bebida', concepto: '[TEST] Gasto', importeSinIva: 100, ivaPercent: 21, fecha: '2093-03-03', ...over }));
  const ingreso = (over: Record<string, unknown> = {}, temporadaId = tid) =>
    createIngreso(json('POST', { temporadaId, concepto: '[TEST] Caja', importe: 50, fecha: '2093-03-03', ...over }));

  beforeAll(async () => {
    await prisma.user.upsert({ where: { id: ACTOR }, update: {}, create: { id: ACTOR, email: ACTOR_EMAIL, role: 'ADMIN' } });
    tid = await nuevaTemporada(2089);
  });

  afterAll(async () => {
    for (const id of temporadas) {
      await prisma.pedido.deleteMany({ where: { temporadaId: id } });
      await prisma.planCompra.deleteMany({ where: { temporadaId: id } });
      await prisma.gasto.deleteMany({ where: { temporadaId: id } });
      await prisma.ingreso.deleteMany({ where: { temporadaId: id } });
    }
    await prisma.articulo.deleteMany({ where: { id: { in: extras.articulos } } });
    await prisma.proveedor.deleteMany({ where: { id: { in: extras.proveedores } } });
    await prisma.temporada.deleteMany({ where: { id: { in: temporadas } } });
    await purgeAuditLog({ actorId: ACTOR });
    await prisma.user.delete({ where: { id: ACTOR } }).catch(() => {});
  });

  // H-055: `fecha: z.string()` sin validar. Un texto con hora u offset se guardaba como instante no medianoche UTC; «abc» daba 500.
  describe('fechas de los apuntes (H-055)', () => {
    it('con hora, con offset, con texto o de un día que no existe: 400 y no se guarda nada (gastos e ingresos)', async () => {
      for (const fecha of ['2093-03-03T10:30:00+02:00', '2093-03-03T23:00:00Z', 'abc', '2093-02-30', '03/03/2093']) {
        const g = await gasto({ fecha, concepto: `[TEST] Fecha mala ${fecha}` });
        expect(g.status, `gasto ${fecha}`).toBe(400);
        const i = await ingreso({ fecha, concepto: `[TEST] Fecha mala ${fecha}` });
        expect(i.status, `ingreso ${fecha}`).toBe(400);
      }
      expect(await prisma.gasto.count({ where: { temporadaId: tid, concepto: { startsWith: '[TEST] Fecha mala' } } })).toBe(0);
      expect(await prisma.ingreso.count({ where: { temporadaId: tid, concepto: { startsWith: '[TEST] Fecha mala' } } })).toBe(0);
    });

    it('YYYY-MM-DD y el ISO a medianoche UTC (lo que devuelve la propia API) valen y se guardan a medianoche UTC', async () => {
      for (const fecha of ['2093-04-04', '2093-04-05T00:00:00.000Z']) {
        const res = await gasto({ fecha, concepto: `[TEST] Fecha buena ${fecha}` });
        expect(res.status, fecha).toBe(200);
        const fila = await prisma.gasto.findFirstOrThrow({ where: { temporadaId: tid, concepto: `[TEST] Fecha buena ${fecha}` } });
        expect(fila.fecha.toISOString().slice(10)).toBe('T00:00:00.000Z');
      }
    });

    it('al editar, una fecha mala (o vacía) da 400, no un 500 de Prisma', async () => {
      const g = await (await gasto({ concepto: '[TEST] Editar fecha' })).json();
      const i = await (await ingreso({ concepto: '[TEST] Editar fecha' })).json();
      for (const fecha of ['abc', '', '2093-03-03T10:00:00+02:00']) {
        expect((await updateGasto(json('PATCH', { fecha }), ctx(g.id))).status, `gasto «${fecha}»`).toBe(400);
        expect((await updateIngreso(json('PATCH', { fecha }), ctx(i.id))).status, `ingreso «${fecha}»`).toBe(400);
      }
      expect((await updateGasto(json('PATCH', { fecha: '2093-05-05' }), ctx(g.id))).status).toBe(200);
    });
  });

  // H-140: IVA sin rango, importes vacíos convertidos en 0, importes que no caben en la columna.
  describe('importes e IVA (H-140)', () => {
    it('IVA fuera de 0-100, vacío o texto: 400; omitido sigue siendo el 21 % de siempre', async () => {
      for (const ivaPercent of [210, -1, '', 'abc', null]) {
        expect((await gasto({ ivaPercent, concepto: '[TEST] IVA malo' })).status, `iva ${JSON.stringify(ivaPercent)}`).toBe(400);
      }
      expect(await prisma.gasto.count({ where: { temporadaId: tid, concepto: '[TEST] IVA malo' } })).toBe(0);
      const omitido = await createGasto(json('POST', { temporadaId: tid, categoria: 'Bebida', concepto: '[TEST] IVA omitido', importeSinIva: 10 }));
      expect(omitido.status).toBe(200);
      expect(Number((await omitido.json()).ivaPercent)).toBe(21);
      const cero = await gasto({ ivaPercent: 0, concepto: '[TEST] IVA cero explícito' });
      expect(cero.status).toBe(200);
    });

    it('importe vacío, nulo, texto o mayor que la columna: 400, no un 0 silencioso ni un 500', async () => {
      for (const importeSinIva of ['', null, 'abc', 1e12]) {
        expect((await gasto({ importeSinIva, concepto: '[TEST] Importe malo' })).status, `gasto ${JSON.stringify(importeSinIva)}`).toBe(400);
      }
      for (const importe of ['', null, 'abc', 1e12]) {
        expect((await ingreso({ importe, concepto: '[TEST] Importe malo' })).status, `ingreso ${JSON.stringify(importe)}`).toBe(400);
      }
      expect(await prisma.gasto.count({ where: { temporadaId: tid, concepto: '[TEST] Importe malo' } })).toBe(0);
      expect(await prisma.ingreso.count({ where: { temporadaId: tid, concepto: '[TEST] Importe malo' } })).toBe(0);
    });

    it('al editar: el IVA y los importes también se validan', async () => {
      const g = await (await gasto({ concepto: '[TEST] Editar importes' })).json();
      const i = await (await ingreso({ concepto: '[TEST] Editar importes' })).json();
      expect((await updateGasto(json('PATCH', { ivaPercent: 210 }), ctx(g.id))).status).toBe(400);
      expect((await updateGasto(json('PATCH', { importeSinIva: '' }), ctx(g.id))).status).toBe(400);
      expect((await updateIngreso(json('PATCH', { importe: '' }), ctx(i.id))).status).toBe(400);
      expect(Number((await prisma.gasto.findUniqueOrThrow({ where: { id: g.id } })).ivaPercent)).toBe(21);
    });

    it('un gasto con el pedido de OTRA temporada es 400; con un pedido que no existe, 404; y un pedido solo puede registrarse una vez (409 con su código)', async () => {
      const otra = await nuevaTemporada(2088, '[TEST] Temporada integridad otra');
      const proveedor = await prisma.proveedor.create({ data: { nombre: '[TEST] Proveedor integridad' } });
      extras.proveedores.push(proveedor.id);
      const pedidoOtra = await prisma.pedido.create({ data: { temporadaId: otra, proveedorId: proveedor.id } });
      const pedidoMia = await prisma.pedido.create({ data: { temporadaId: tid, proveedorId: proveedor.id } });

      expect((await gasto({ pedidoId: pedidoOtra.id, concepto: '[TEST] Pedido ajeno' })).status).toBe(400);
      expect((await gasto({ pedidoId: 'no-existe', concepto: '[TEST] Pedido fantasma' })).status).toBe(404);

      expect((await gasto({ pedidoId: pedidoMia.id, concepto: '[TEST] Pedido bueno' })).status).toBe(200);
      const repetido = await gasto({ pedidoId: pedidoMia.id, concepto: '[TEST] Pedido repetido' });
      expect(repetido.status).toBe(409);
      expect((await repetido.json()).code).toBe('pedido_ya_registrado');

      // Doble envío del formulario: la otra alta ya está en curso (sin confirmar) cuando llega ésta. La comprobación de arriba no la ve; el único de `pedidoId`
      // sí: la segunda recibe 409 (no un 500) y queda UNA sola fila.
      const pedidoDoble = await prisma.pedido.create({ data: { temporadaId: tid, proveedorId: proveedor.id } });
      const enCurso = prisma.$transaction(
        async (tx) => {
          await tx.gasto.create({ data: { temporadaId: tid, categoria: 'Otros', concepto: '[TEST] Doble A', importeSinIva: 1, ivaPercent: 0, pedidoId: pedidoDoble.id } });
          await sleep(700);
        },
        { timeout: 15_000 }
      );
      await sleep(200);
      const b = await gasto({ pedidoId: pedidoDoble.id, concepto: '[TEST] Doble B' });
      await enCurso;
      expect(b.status).toBe(409);
      expect((await b.json()).code).toBe('pedido_ya_registrado');
      expect(await prisma.gasto.count({ where: { pedidoId: pedidoDoble.id } })).toBe(1);
    });
  });

  // H-148: mutaciones de P1-16 que sobrevivían. Cada una se cubre aquí con un día/temporada propios (sin depender de datos compartidos, H-007).
  describe('lo anulado no cuenta en ninguna cifra ni salida (H-148)', () => {
    it('el resumen de Ingresos descuenta de gastoTotal y balance los gastos anulados', async () => {
      const t = await nuevaTemporada(2087, '[TEST] Temporada resumen anulados');
      const fuera = await (await gasto({ importeSinIva: 100, ivaPercent: 0, concepto: '[TEST] Se anula' }, t)).json();
      await gasto({ importeSinIva: 40, ivaPercent: 0, concepto: '[TEST] Se queda' }, t);
      await ingreso({ importe: 500 }, t);
      const ingresoFuera = await (await ingreso({ importe: 300 }, t)).json();
      expect((await voidGasto(json('DELETE', { motivo: 'Factura duplicada' }), ctx(fuera.id))).status).toBe(200);
      expect((await voidIngreso(json('DELETE', { motivo: 'Contado dos veces' }), ctx(ingresoFuera.id))).status).toBe(200);
      const res = await (await resumenIngresos(new Request(`http://localhost?temporadaId=${t}`))).json();
      expect(res.gastoTotal).toBe(40);
      expect(res.ingresoTotal).toBe(500);
      expect(res.nIngresos).toBe(1);
      expect(res.balance).toBe(460);
    });

    it('el cuadre de caja (ventas por día) no suma ingresos «Entradas» anulados', async () => {
      const t = await nuevaTemporada(2086, '[TEST] Temporada cuadre anulados');
      const dia = '2093-07-07';
      const fuera = await (await ingreso({ concepto: 'Entradas', importe: 7777, fecha: dia }, t)).json();
      await ingreso({ concepto: 'Entradas', importe: 10, fecha: dia }, t);
      expect((await voidIngreso(json('DELETE', { motivo: 'Contado dos veces' }), ctx(fuera.id))).status).toBe(200);
      const data = await (await ventasPorDia(new Request(`http://localhost/api/admin/stats/ventas-por-dia?from=${dia}&to=${dia}`))).json();
      expect(data.dias.find((d: { fecha: string }) => d.fecha === dia).cajaEntradas).toBe(10);
    });

    it('anular un gasto suelta su pedido (para poder registrarlo otra vez) y el rastro conserva cuál era', async () => {
      const proveedor = await prisma.proveedor.create({ data: { nombre: '[TEST] Proveedor anulado' } });
      extras.proveedores.push(proveedor.id);
      const pedido = await prisma.pedido.create({ data: { temporadaId: tid, proveedorId: proveedor.id } });
      const g = await (await gasto({ pedidoId: pedido.id, concepto: '[TEST] Con pedido' })).json();
      expect((await voidGasto(json('DELETE', { motivo: 'Importe mal puesto' }), ctx(g.id))).status).toBe(200);
      expect((await prisma.gasto.findUniqueOrThrow({ where: { id: g.id } })).pedidoId).toBeNull();
      const [fila] = await prisma.adminAuditLog.findMany({ where: { action: 'gasto.void', targetId: g.id } });
      expect(fila.meta).toMatchObject({ pedidoId: pedido.id });
      expect((await gasto({ pedidoId: pedido.id, concepto: '[TEST] Registrado de nuevo' })).status).toBe(200);
    });

    describe('GET /api/admin/gastos/export', () => {
      const get = (qs: string) => exportGastos(new Request(`http://localhost/api/admin/gastos/export?${qs}`));

      it('pide sesión de administrador, temporada y un formato válido', async () => {
        role = null;
        try {
          expect((await get(`temporadaId=${tid}&format=excel`)).status).toBe(401);
        } finally {
          role = 'ADMIN';
        }
        expect((await get('format=excel')).status).toBe(400);
        expect((await get(`temporadaId=${tid}&format=csv`)).status).toBe(400);
        expect((await get('temporadaId=no-existe&format=excel')).status).toBe(404);
      });

      it('una temporada sin gastos da 400 aunque tenga anulados', async () => {
        const t = await nuevaTemporada(2085, '[TEST] Temporada export vacía');
        const g = await (await gasto({ concepto: '[TEST] Solo anulado' }, t)).json();
        await voidGasto(json('DELETE', { motivo: 'Anulado para el test' }), ctx(g.id));
        expect((await get(`temporadaId=${t}&format=excel`)).status).toBe(400);
      });

      it('el Excel y el PDF salen con los gastos vigentes y sin los anulados', async () => {
        const t = await nuevaTemporada(2084, '[TEST] Temporada export');
        const fuera = await (await gasto({ concepto: '[TEST] Export ANULADO', importeSinIva: 11 }, t)).json();
        await gasto({ concepto: '[TEST] Export VIGENTE', importeSinIva: 22 }, t);
        await voidGasto(json('DELETE', { motivo: 'Anulado para el test' }), ctx(fuera.id));

        const excel = await get(`temporadaId=${t}&format=excel`);
        expect(excel.status).toBe(200);
        expect(excel.headers.get('Content-Type')).toContain('spreadsheetml');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load((await excel.arrayBuffer()) as ArrayBuffer);
        const celdas: string[] = [];
        wb.eachSheet((s) => s.eachRow((r) => r.eachCell((c) => celdas.push(String(c.value ?? '')))));
        expect(celdas).toContain('[TEST] Export VIGENTE');
        expect(celdas).not.toContain('[TEST] Export ANULADO');

        const pdf = await get(`temporadaId=${t}&format=pdf`);
        expect(pdf.status).toBe(200);
        expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
        expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
      });
    });
  });

  // H-014: `checkTemporadaAbierta` se hacía FUERA de la transacción: un cierre entre la comprobación y la escritura dejaba un apunte nuevo en una temporada ya cerrada.
  describe('cerrar una temporada y escribir en ella a la vez (H-014)', () => {
    const cierraDurante = async (temporadaId: string, escritura: () => Promise<Response>) => {
      // Una transacción de cierre que sigue abierta (con la fila bloqueada) mientras llega la escritura.
      const cierre = prisma.$transaction(
        async (tx) => {
          await tx.temporada.update({ where: { id: temporadaId }, data: { status: 'CERRADA', closedAt: new Date() } });
          await sleep(700);
        },
        { timeout: 15_000 }
      );
      await sleep(200);
      const res = await escritura();
      await cierre;
      return res;
    };

    it('un gasto que llega mientras se cierra la temporada recibe 423 y no se guarda', async () => {
      const t = await nuevaTemporada(2083, '[TEST] Temporada carrera gasto');
      const res = await cierraDurante(t, () => gasto({ concepto: '[TEST] Llega tarde' }, t));
      expect(res.status).toBe(423);
      expect(await prisma.gasto.count({ where: { temporadaId: t } })).toBe(0);
    });

    it('anular un ingreso mientras se cierra la temporada recibe 423 y no queda anulado', async () => {
      const t = await nuevaTemporada(2082, '[TEST] Temporada carrera anulación');
      const i = await (await ingreso({}, t)).json();
      const res = await cierraDurante(t, () => voidIngreso(json('DELETE', { motivo: 'Llega tarde al cierre' }), ctx(i.id)));
      expect(res.status).toBe(423);
      expect((await prisma.ingreso.findUniqueOrThrow({ where: { id: i.id } })).voidedAt).toBeNull();
    });

    it('modificar un gasto mientras se cierra la temporada recibe 423 y no cambia', async () => {
      const t = await nuevaTemporada(2081, '[TEST] Temporada carrera cambio');
      const g = await (await gasto({ importeSinIva: 100 }, t)).json();
      const res = await cierraDurante(t, () => updateGasto(json('PATCH', { importeSinIva: 999 }), ctx(g.id)));
      expect(res.status).toBe(423);
      expect(Number((await prisma.gasto.findUniqueOrThrow({ where: { id: g.id } })).importeSinIva)).toBe(100);
    });
  });

  // H-015: un PATCH de temporada que no cambia nada escribía una fila de auditoría vacía.
  describe('guardar una temporada sin cambios no deja rastro vacío (H-015)', () => {
    it('mismo estado o mismo nombre: sin fila; un cambio real sí', async () => {
      const t = await nuevaTemporada(2080, '[TEST] Temporada sin cambios');
      const filas = () => prisma.adminAuditLog.count({ where: { actorId: ACTOR, action: 'temporada.update', targetId: t } });
      expect((await patchTemporada(json('PATCH', { status: 'ABIERTA' }), ctx(t))).status).toBe(200);
      expect((await patchTemporada(json('PATCH', { nombre: '[TEST] Temporada sin cambios' }), ctx(t))).status).toBe(200);
      expect(await filas()).toBe(0);
      expect((await patchTemporada(json('PATCH', { nombre: '[TEST] Temporada con cambio' }), ctx(t))).status).toBe(200);
      expect(await filas()).toBe(1);
    });
  });

  // H-141: el planificador solo cuenta artículos activos y «Generar pedidos» no filtraba: un artículo desactivado tras planificarlo generaba línea de pedido.
  describe('«Generar pedidos» y el planificador suman lo mismo (H-141)', () => {
    it('un artículo desactivado después de planificarlo no genera línea', async () => {
      const t = await nuevaTemporada(2079, '[TEST] Temporada generar');
      const proveedor = await prisma.proveedor.create({ data: { nombre: '[TEST] Proveedor generar' } });
      extras.proveedores.push(proveedor.id);
      const mk = async (nombre: string, activo: boolean) => {
        const a = await prisma.articulo.create({ data: { nombre, categoria: 'Test', formato: 'ud', activo } });
        extras.articulos.push(a.id);
        await prisma.precioArticulo.create({ data: { articuloId: a.id, proveedorId: proveedor.id, precioSinIva: 2, formatoVenta: 'ud' } });
        await prisma.planCompra.create({ data: { temporadaId: t, articuloId: a.id, cantidadPlanificada: 5 } });
        return a;
      };
      const vivo = await mk('[TEST] Artículo activo', true);
      await mk('[TEST] Artículo desactivado', false);
      const res = await generarPedidos(json('POST', { temporadaId: t }));
      expect(res.status).toBe(200);
      const { pedidos } = (await res.json()) as { pedidos: { lineas: { articuloId: string }[] }[] };
      expect(pedidos).toHaveLength(1);
      expect(pedidos[0].lineas.map((l) => l.articuloId)).toEqual([vivo.id]);
    });
  });
});
