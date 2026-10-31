import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getAndSetConfig, restoreConfig } from '../helpers/fixtures';

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-ingresos-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: listIngresos, POST: createIngreso } = await import('@/app/api/admin/ingresos/route');
const { PATCH: updateIngreso, DELETE: deleteIngreso } = await import('@/app/api/admin/ingresos/[id]/route');
const { GET: resumenIngresos } = await import('@/app/api/admin/ingresos/resumen/route');
const { POST: createGasto } = await import('@/app/api/admin/gastos/route');

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// AUDIT: la caja física de la caseta (entradas en puerta, barra...) no tenía
// dónde registrarse — el balance de la temporada solo podía calcularse a
// partir de entradas online y patrocinios, nunca del dinero real contado
// cada noche.
describe('CRUD /api/admin/ingresos', () => {
  let temporadaId: string;

  beforeAll(async () => {
    // createdById es una FK real a User — el admin de la sesión mockeada
    // necesita existir en BD o el POST falla con un P2003 (violación de FK).
    await prisma.user.upsert({
      where: { id: 'admin-ingresos-test' },
      update: {},
      create: { id: 'admin-ingresos-test', email: 'admin-ingresos-test@example.com', role: 'ADMIN' },
    });
    const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada ingresos', anio: 2098 } });
    temporadaId = temporada.id;
  });

  afterAll(async () => {
    await prisma.ingreso.deleteMany({ where: { temporadaId } });
    await prisma.temporada.delete({ where: { id: temporadaId } });
    await prisma.user.delete({ where: { id: 'admin-ingresos-test' } }).catch(() => {});
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = null;
    const res = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Entradas', importe: 100 }));
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('crea un ingreso con la fecha e importe indicados', async () => {
    const res = await createIngreso(
      jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Entradas', importe: 320.5, fecha: '2026-09-25', notas: 'Viernes noche' })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.concepto).toBe('Entradas');
    expect(data.importe).toBe(320.5);
    expect(data.notas).toBe('Viernes noche');
  });

  it('lista los ingresos de la temporada ordenados por fecha', async () => {
    await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Barra', importe: 210, fecha: '2026-09-26' }));
    const res = await listIngresos(new Request(`http://localhost?temporadaId=${temporadaId}`));
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(new Date(data[0].fecha).getTime()).toBeLessThanOrEqual(new Date(data[data.length - 1].fecha).getTime());
  });

  it('edita un ingreso existente', async () => {
    const created = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Otros', importe: 50, fecha: '2026-09-27' }));
    const { id } = await created.json();

    const res = await updateIngreso(jsonRequest('http://localhost', 'PATCH', { importe: 75 }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.importe).toBe(75);
  });

  it('elimina un ingreso', async () => {
    const created = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Comida', importe: 40, fecha: '2026-09-27' }));
    const { id } = await created.json();

    const res = await deleteIngreso(jsonRequest('http://localhost', 'DELETE'), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);

    const found = await prisma.ingreso.findUnique({ where: { id } });
    expect(found).toBeNull();
  });
});

/* P1-15: sin fecha, la API guardaba el INSTANTE actual y los formularios proponían el día UTC: entre las 00:00 y las 02:00 de Madrid (verano) la caja
 * de «hoy» se anotaba en el día anterior. Ahora la fecha por defecto es la jornada de negocio (ingresos) o el día natural (gastos), en hora de Madrid,
 * guardada como medianoche UTC igual que el resto de filas. */
describe('fecha por defecto en hora de Madrid (P1-15)', () => {
  let temporadaId: string;
  // 22:30 UTC del 31/10/2026 = 23:30 en Madrid (CET). Para llegar a las 00:30 del 1 de noviembre hacen falta 23:30 UTC.
  const MADRUGADA = new Date('2026-10-31T23:30:00Z'); // 00:30 del domingo 1/11 en Madrid; el día UTC sigue siendo el 31/10

  beforeAll(async () => {
    await prisma.user.upsert({ where: { id: 'admin-ingresos-test' }, update: {}, create: { id: 'admin-ingresos-test', email: 'admin-ingresos-test@example.com', role: 'ADMIN' } });
    temporadaId = (await prisma.temporada.create({ data: { nombre: '[TEST] Temporada fecha Madrid', anio: 2096 } })).id;
  });
  afterAll(async () => {
    vi.useRealTimers();
    await prisma.ingreso.deleteMany({ where: { temporadaId } });
    await prisma.gasto.deleteMany({ where: { temporadaId } });
    await prisma.temporada.delete({ where: { id: temporadaId } });
    await prisma.user.delete({ where: { id: 'admin-ingresos-test' } }).catch(() => {});
  });

  const at = (when: Date) => vi.useFakeTimers({ toFake: ['Date'], now: when, shouldAdvanceTime: true });
  const withCorte = async (corte: string, fn: () => Promise<void>) => {
    const prev = await getAndSetConfig('jornada_corte_hora', corte);
    try {
      await fn();
    } finally {
      vi.useRealTimers();
      await restoreConfig('jornada_corte_hora', prev);
    }
  };

  it('un ingreso SIN fecha a las 00:30 de Madrid, sin corte, se anota en el día de Madrid (medianoche UTC), no en el día UTC', async () => {
    await withCorte('0', async () => {
      at(MADRUGADA);
      const res = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Entradas', importe: 10 }));
      expect(res.status).toBe(200);
      expect((await res.json()).fecha).toBe('2026-11-01T00:00:00.000Z');
    });
  });

  it('con corte a las 06:00, el mismo ingreso sin fecha se anota en la JORNADA que empezó el sábado (la caja de la noche)', async () => {
    await withCorte('6', async () => {
      at(MADRUGADA);
      const res = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Entradas', importe: 10 }));
      expect((await res.json()).fecha).toBe('2026-10-31T00:00:00.000Z');
    });
  });

  it('una fecha explícita se respeta tal cual, con o sin corte', async () => {
    await withCorte('6', async () => {
      at(MADRUGADA);
      const res = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Entradas', importe: 10, fecha: '2026-09-20' }));
      expect((await res.json()).fecha).toBe('2026-09-20T00:00:00.000Z');
    });
  });

  it('el resumen de caja trae la jornada de «ahora» para que el formulario la proponga (la misma que usaría el servidor)', async () => {
    const jornada = async (corte: string) => {
      let value = '';
      await withCorte(corte, async () => {
        at(MADRUGADA);
        const res = await resumenIngresos(new Request(`http://localhost/api/admin/ingresos/resumen?temporadaId=${temporadaId}`));
        value = (await res.json()).jornadaHoy;
      });
      return value;
    };
    expect(await jornada('0')).toBe('2026-11-01');
    expect(await jornada('6')).toBe('2026-10-31');
  });

  it('un gasto SIN fecha usa el día natural de Madrid (el corte de la jornada es de la caja, no de las facturas)', async () => {
    await withCorte('6', async () => {
      at(MADRUGADA);
      const res = await createGasto(jsonRequest('http://localhost', 'POST', { temporadaId, categoria: 'Otros', concepto: 'Prueba fecha', importeSinIva: 10 }));
      expect(res.status).toBe(200);
      expect((await res.json()).fecha).toBe('2026-11-01T00:00:00.000Z');
    });
  });
});
