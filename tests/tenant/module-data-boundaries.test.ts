import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Revisión de módulos (2026-10): el middleware corta las RUTAS de un módulo apagado, pero varios handlers y páginas de otros módulos
 * seguían leyendo sus tablas. Un cliente sin Entradas, Sponsors, Contabilidad o Wallets no debe ver ni un dato de ellos. */

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'u1', role: 'ADMIN' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

let env: ReturnType<typeof enablePlatformEnv>;
const NUCLEO = ['nucleo'];
const TODO = ['nucleo', 'entradas', 'tienda', 'contabilidad', 'sponsors', 'wallets'];

async function seed() {
  const db = tenantClient('a');
  const temporada = await db.temporada.create({ data: { nombre: 'Temporada 2026', anio: 2026 } });
  const event = await db.event.create({
    data: { name: 'Evento de prueba', slug: 'evento-de-prueba', venue: 'Sala', city: 'Valencia', date: new Date('2026-12-01T20:00:00Z'), status: 'PUBLISHED', temporadaId: temporada.id },
  });
  await db.order.create({ data: { eventId: event.id, buyerName: 'Ana', buyerLastName: 'Test', buyerEmail: 'ana@example.com', totalAmount: 100, status: 'COMPLETED' } });
  const request = await db.sponsorRequest.create({ data: { companyName: 'Marca SL', contactName: 'Pepe', email: 'marca@example.com', temporadaId: temporada.id } });
  await db.sponsor.create({ data: { sponsorRequestId: request.id, isPaid: true, paidAmount: 500 } });
  await db.ingreso.create({ data: { temporadaId: temporada.id, fecha: new Date('2026-10-01T00:00:00Z'), concepto: 'Entradas', importe: 50 } });
  return { temporada, event };
}

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
}, 180_000);
beforeEach(async () => {
  await resetTenantDatabase('a');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('Resumen de gastos y margen — solo suma lo de los módulos activos', () => {
  const resumen = async (temporadaId: string, modules: string[]) => {
    const { GET } = await import('@/app/api/admin/gastos/resumen/route');
    const res = await withTenantForTest('a', () => GET(new Request(`http://a.cliente.test/api/admin/gastos/resumen?temporadaId=${temporadaId}`)), { modules });
    return res.json() as Promise<{ ingresosEntradas: number; ingresosPatrocinio: number; ingresos: number; nEventosEnlazados: number }>;
  };

  it('sin Entradas ni Sponsors, sus pedidos y patrocinios no entran en el margen', async () => {
    const { temporada } = await seed();
    const data = await resumen(temporada.id, ['nucleo', 'contabilidad']);
    expect(data.ingresosEntradas).toBe(0);
    expect(data.ingresosPatrocinio).toBe(0);
    expect(data.ingresos).toBe(0);
    expect(data.nEventosEnlazados).toBe(0);
  });

  it('con Entradas y Sponsors activos suma lo de siempre', async () => {
    const { temporada } = await seed();
    const data = await resumen(temporada.id, TODO);
    expect(data.ingresosEntradas).toBe(100);
    expect(data.ingresosPatrocinio).toBe(500);
    expect(data.ingresos).toBe(600);
  });
});

describe('Ventas por día — la caja manual es de Contabilidad', () => {
  const ventas = async (modules: string[]) => {
    const { GET } = await import('@/app/api/admin/stats/ventas-por-dia/route');
    const res = await withTenantForTest('a', () => GET(new Request('http://a.cliente.test/api/admin/stats/ventas-por-dia')), { modules });
    return JSON.stringify(await res.json());
  };

  it('sin Contabilidad, la respuesta es idéntica haya o no ingresos manuales guardados', async () => {
    await seed();
    const conCaja = await ventas(['nucleo', 'entradas']);
    await tenantClient('a').ingreso.deleteMany({});
    const sinCaja = await ventas(['nucleo', 'entradas']);
    expect(conCaja).toBe(sinCaja);
  });

  it('con Contabilidad activa la caja manual sí aparece (el test distingue)', async () => {
    await seed();
    const conCaja = await ventas(['nucleo', 'entradas', 'contabilidad']);
    await tenantClient('a').ingreso.deleteMany({});
    const sinCaja = await ventas(['nucleo', 'entradas', 'contabilidad']);
    expect(conCaja).not.toBe(sinCaja);
  });
});

describe('Wallets — no se ofrecen sin el módulo', () => {
  it('con claves guardadas pero sin el módulo Wallets, no hay disponibilidad', async () => {
    const db = tenantClient('a');
    await db.appConfig.createMany({
      data: [
        { key: 'google_wallet_issuer_id', value: '3388000000000000000', label: 'x', group: 'wallets' },
        { key: 'google_wallet_service_account', value: '{"client_email":"x@y.iam"}', label: 'x', group: 'wallets' },
      ],
    });
    const { getWalletAvailability } = await import('@/lib/wallet');
    expect(await withTenantForTest('a', () => getWalletAvailability(), { modules: ['nucleo', 'entradas'] })).toEqual({ google: false, apple: false });
    expect((await withTenantForTest('a', () => getWalletAvailability(), { modules: ['nucleo', 'entradas', 'wallets'] })).google).toBe(true);
  });
});

describe('Sitemap — solo lista lo que el cliente tiene', () => {
  const urls = async (modules: string[]) => {
    const { default: sitemap } = await import('@/app/sitemap');
    return (await withTenantForTest('a', () => sitemap(), { modules })).map((e) => e.url);
  };

  it('sin módulos de negocio no aparecen eventos, tienda, sponsors ni los slugs de eventos', async () => {
    await seed();
    const list = await urls(NUCLEO);
    expect(list.some((u) => /\/(eventos|tienda|sponsors)(\/|$)/.test(u))).toBe(false);
    expect(list.some((u) => u.endsWith('/legal/privacidad'))).toBe(true);
  });

  it('con Entradas aparecen /eventos y los eventos publicados, y sigue sin /tienda ni /sponsors', async () => {
    await seed();
    const list = await urls(['nucleo', 'entradas']);
    expect(list.some((u) => u.endsWith('/eventos'))).toBe(true);
    expect(list.some((u) => u.endsWith('/eventos/evento-de-prueba'))).toBe(true);
    expect(list.some((u) => /\/(tienda|sponsors)$/.test(u))).toBe(false);
  });
});

describe('Vínculo con la temporada — es cosa de Contabilidad', () => {
  const listEvents = async (modules: string[]) => {
    const { GET } = await import('@/app/api/admin/events/route');
    const res = await withTenantForTest('a', () => GET(new Request('http://a.cliente.test/api/admin/events')), { modules });
    return (await res.json()) as Record<string, unknown>[];
  };
  const patchEvent = async (id: string, body: unknown, modules: string[]) => {
    const { PATCH } = await import('@/app/api/admin/events/[id]/route');
    return withTenantForTest('a', () => PATCH(new Request('http://a.cliente.test/api/admin/events/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: { id } }), { modules });
  };

  it('sin Contabilidad, el listado de eventos no devuelve el nombre de la temporada', async () => {
    await seed();
    const rows = await listEvents(['nucleo', 'entradas']);
    expect(rows).toHaveLength(1);
    expect('temporada' in rows[0]).toBe(false);
  });

  it('con Contabilidad el listado sí la incluye (regresión)', async () => {
    await seed();
    const rows = await listEvents(['nucleo', 'entradas', 'contabilidad']);
    expect((rows[0].temporada as { nombre: string }).nombre).toBe('Temporada 2026');
  });

  it('sin Contabilidad no se puede enlazar un evento a una temporada; con ella sí', async () => {
    const { temporada, event } = await seed();
    const db = tenantClient('a');
    await db.event.update({ where: { id: event.id }, data: { temporadaId: null } });

    await patchEvent(event.id, { temporadaId: temporada.id }, ['nucleo', 'entradas']);
    expect((await db.event.findUnique({ where: { id: event.id } }))?.temporadaId).toBeNull();

    await patchEvent(event.id, { temporadaId: temporada.id }, ['nucleo', 'entradas', 'contabilidad']);
    expect((await db.event.findUnique({ where: { id: event.id } }))?.temporadaId).toBe(temporada.id);
  });
});
