import { describe, expect, it } from 'vitest';
import { OpsBlockSchema, SALES_BUSY_ORDERS_15MIN, isSalesWindowBusy, moduleObligations, parseOpsBlock } from '../src';

const ok = {
  generatedAt: '2026-10-27T10:00:00.000Z',
  pendingOldestMinutes: 4,
  pendingOver20min: 0,
  emailsUnsent: 0,
  emailsFailed: 0,
  reconcile: { lastRunAt: '2026-10-27T09:58:00.000Z', errors: 0, unknown: 0, processing: 1, stuckOver24h: 0 },
};

describe('bloque ops de la salud (contrato)', () => {
  it('acepta la forma acordada con el front', () => {
    expect(OpsBlockSchema.parse(ok)).toEqual(ok);
    expect(parseOpsBlock(ok)).toEqual({ status: 'ok', ops: ok });
  });

  it('admite null donde el contrato lo permite (sin pendientes, sin pasadas registradas, sin última pasada)', () => {
    expect(OpsBlockSchema.safeParse({ ...ok, pendingOldestMinutes: null, reconcile: null }).success).toBe(true);
    expect(OpsBlockSchema.safeParse({ ...ok, reconcile: { ...ok.reconcile, lastRunAt: null } }).success).toBe(true);
  });

  it('el bloque `gateway` (conciliación diaria con la pasarela) es opcional y, si viene, se valida', () => {
    const gateway = { lastRunAt: '2026-10-27T09:00:00.000Z', checked: 12, unmatched: 0, errors: 0, skipped: 1, truncated: false };
    expect(parseOpsBlock({ ...ok, gateway })).toEqual({ status: 'ok', ops: { ...ok, gateway } });
    expect(parseOpsBlock({ ...ok, gateway: null })).toMatchObject({ status: 'ok' }); // aún no ha corrido
    expect(parseOpsBlock(ok)).toMatchObject({ status: 'ok' }); // front anterior
    expect(parseOpsBlock({ ...ok, gateway: { ...gateway, unmatched: -1 } })).toMatchObject({ status: 'invalid' });
    expect(parseOpsBlock({ ...ok, gateway: { ...gateway, truncated: 'no' } })).toMatchObject({ status: 'invalid' });
  });

  it('el bloque `sales` (actividad de venta, P1-22) es opcional y, si viene, se valida', () => {
    const sales = { orders15min: 3, waitingRoom: 0 };
    expect(parseOpsBlock({ ...ok, sales })).toEqual({ status: 'ok', ops: { ...ok, sales } });
    expect(parseOpsBlock({ ...ok, sales: null })).toMatchObject({ status: 'ok' }); // no se pudo medir
    expect(parseOpsBlock(ok)).toMatchObject({ status: 'ok' }); // front anterior
    expect(parseOpsBlock({ ...ok, sales: { orders15min: -1, waitingRoom: 0 } })).toMatchObject({ status: 'invalid' });
    expect(parseOpsBlock({ ...ok, sales: { orders15min: 1 } })).toMatchObject({ status: 'invalid' });
  });

  it('`isSalesWindowBusy`: sala de espera con gente, o ritmo de pedidos sostenido; con poco movimiento no', () => {
    expect(isSalesWindowBusy({ orders15min: 0, waitingRoom: 0 })).toBe(false);
    expect(isSalesWindowBusy({ orders15min: SALES_BUSY_ORDERS_15MIN - 1, waitingRoom: 0 })).toBe(false);
    expect(isSalesWindowBusy({ orders15min: SALES_BUSY_ORDERS_15MIN, waitingRoom: 0 })).toBe(true);
    expect(isSalesWindowBusy({ orders15min: 0, waitingRoom: 1 })).toBe(true);
  });

  it('`obligations` (P1-20): opcional, nullable y con cuatro contadores no negativos', () => {
    const o = { ticketOrdersPending: 0, futureEventsWithTickets: 1, shopOrdersPending: 2, shopOrdersToShip: 3 };
    expect(parseOpsBlock({ ...ok, obligations: o })).toEqual({ status: 'ok', ops: { ...ok, obligations: o } });
    expect(parseOpsBlock({ ...ok, obligations: null }).status).toBe('ok');
    expect(parseOpsBlock({ ...ok, obligations: { ...o, shopOrdersToShip: -1 } }).status).toBe('invalid');
    expect(parseOpsBlock({ ...ok, obligations: { ticketOrdersPending: 1 } }).status).toBe('invalid');
  });

  it('`moduleObligations`: cada módulo solo mira lo suyo, y sin obligaciones no bloquea', () => {
    const open = { ticketOrdersPending: 2, futureEventsWithTickets: 1, shopOrdersPending: 4, shopOrdersToShip: 5 };
    expect(moduleObligations('entradas', open)).toEqual(['2 pedido(s) de entradas pendientes de pago', '1 evento(s) por venir con entradas vendidas']);
    expect(moduleObligations('tienda', open)).toEqual(['4 pedido(s) de tienda pendientes de pago', '5 pedido(s) de tienda pagados sin enviar']);
    for (const m of ['contabilidad', 'wallets', 'sponsors', 'nucleo']) expect(moduleObligations(m, open)).toEqual([]);
    const none = { ticketOrdersPending: 0, futureEventsWithTickets: 0, shopOrdersPending: 0, shopOrdersToShip: 0 };
    expect(moduleObligations('entradas', none)).toEqual([]);
    expect(moduleObligations('tienda', none)).toEqual([]);
  });

  it('ausente (front anterior) no es un error; null tampoco', () => {
    expect(parseOpsBlock(undefined)).toEqual({ status: 'absent' });
    expect(parseOpsBlock(null)).toEqual({ status: 'absent' });
  });

  it('los campos desconocidos se ignoran (el front puede añadir contadores sin romper a un panel antiguo)', () => {
    const r = parseOpsBlock({ ...ok, gatewayCredOk: true, reconcile: { ...ok.reconcile, algoNuevo: 7 } });
    expect(r).toEqual({ status: 'ok', ops: ok });
    expect(JSON.stringify(r)).not.toMatch(/gatewayCredOk|algoNuevo/);
  });

  it.each([
    ['falta un contador', { ...ok, emailsUnsent: undefined }],
    ['contador negativo', { ...ok, emailsFailed: -1 }],
    ['contador como texto', { ...ok, pendingOver20min: '3' }],
    ['NaN o infinito', { ...ok, pendingOver20min: Number.POSITIVE_INFINITY }],
    ['fecha ilegible', { ...ok, generatedAt: 'ayer' }],
    ['última pasada ilegible', { ...ok, reconcile: { ...ok.reconcile, lastRunAt: 'nunca' } }],
    ['reconcile incompleto', { ...ok, reconcile: { lastRunAt: null } }],
    ['no es un objeto', 'ok'],
  ])('rechaza una forma que no cumple el contrato: %s', (_name, value) => {
    const r = parseOpsBlock(value);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.issue.length).toBeGreaterThan(0);
  });

  it('el aviso de un bloque no válido no copia los valores recibidos (solo la ruta y el motivo)', () => {
    const r = parseOpsBlock({ ...ok, generatedAt: 'comprador@correo.es' });
    expect(r.status).toBe('invalid');
    expect(JSON.stringify(r)).not.toContain('comprador@correo.es');
  });
});

describe('contadores no medidos (null)', () => {
  const base = { generatedAt: '2026-10-27T10:00:00.000Z', pendingOldestMinutes: null, pendingOver20min: 0, emailsUnsent: 0, emailsFailed: 0, reconcile: null };

  it('acepta null en los tres contadores: el front no pudo ejecutar esa consulta y las demás señales siguen siendo válidas', () => {
    const r = parseOpsBlock({ ...base, pendingOver20min: null, emailsUnsent: null, emailsFailed: null });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.ops.pendingOver20min).toBeNull();
      expect(r.ops.emailsUnsent).toBeNull();
      expect(r.ops.emailsFailed).toBeNull();
    }
  });

  it('sigue rechazando valores negativos o no numéricos', () => {
    expect(parseOpsBlock({ ...base, emailsFailed: -1 }).status).toBe('invalid');
    expect(parseOpsBlock({ ...base, pendingOver20min: 'muchos' }).status).toBe('invalid');
  });
});
