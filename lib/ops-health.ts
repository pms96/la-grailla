import { prisma } from '@/lib/prisma';
import { countEmailBacklog } from '@/lib/email-delivery';
import { CHECKOUT_RELEASE_AFTER_MS } from '@/lib/checkout-hold';
import { currentTenant } from '@/lib/tenant/context';

/* Bloque `ops` de /api/health: las señales de negocio que el panel necesita para alertar antes que el comprador (P0-07 · OB-06).
 *
 *  - BARATO: consultas agregadas sobre índices existentes. No llama a ninguna pasarela ni al SMTP.
 *  - A PRUEBA DE FALLOS: cada medida se recoge por separado y con un tope de tiempo global; si una falla o no llega a tiempo, su campo sale
 *    `null` y el resto sigue. Si no se pudo recoger NADA, el bloque entero es `null`. Nunca lanza: el health no puede fallar por esto.
 *  - SIN datos personales ni ids de pedido: solo recuentos y minutos. */

/** Clave de sistema de AppConfig donde el cron de reconciliación guarda cómo terminó su última pasada (sin migración). No es secreta ni editable:
 *  está en INTERNAL_CONFIG_KEYS (lib/config-ownership.ts), así que ni el GET ni el PUT de configuración la ven. */
export const OPS_RECONCILE_KEY = 'ops_reconcile_last';

/** Clave de sistema con el resultado de la última conciliación diaria pasarela↔BD (lib/reconciliation/gateway.ts). Igual que la anterior: sin migración. */
export const OPS_GATEWAY_KEY = 'ops_gateway_last';

/** Cómo terminó la última conciliación diaria con la pasarela. */
export interface GatewaySummary {
  lastRunAt: string;
  /** Cobros (o pedidos sin pagar, en SumUp) contrastados. */
  checked: number;
  /** Cobros que no cuadran con la BD: pagados en la pasarela y sin pedido confirmado. Debe ser 0. */
  unmatched: number;
  /** Cuentas de cobro que no se pudieron consultar (credencial inválida, pasarela caída). */
  errors: number;
  /** Cuentas con cobertura parcial (SumUp: no se pueden detectar cobros SIN pedido). */
  skipped: number;
  /** La lista se cortó por tope de páginas o de tiempo. */
  truncated: boolean;
}

export interface ReconcileSummary {
  lastRunAt: string;
  errors: number;
  unknown: number;
  processing: number;
  stuckOver24h: number;
}

export interface OpsBlock {
  generatedAt: string;
  /** Edad (min) del PENDING más antiguo FUERA DE PLAZO (más de ~45 min: el sistema ya debía haberlo liberado) con pago en una pasarela real (entradas + tienda); null si no hay ninguno (o no se pudo medir: ver el resto). */
  pendingOldestMinutes: number | null;
  /** Pedidos PENDING con pago en la pasarela fuera de plazo (más de ~45 min). El nombre del campo es histórico (antes 20 min) y es parte del contrato. null = no se pudo medir. */
  pendingOver20min: number | null;
  /** Pedidos pagados con el email sin confirmar (con algún intento fallido o con más de 10 min sin intentarse) y con intentos pendientes. null = no se pudo medir. */
  emailsUnsent: number | null;
  /** Pedidos con los intentos de email agotados (últimos 7 días). null = no se pudo medir. */
  emailsFailed: number | null;
  /** Cómo terminó la última pasada del cron de reconciliación; null si aún no ha corrido o no se pudo leer. */
  reconcile: (Omit<ReconcileSummary, 'lastRunAt'> & { lastRunAt: string | null }) | null;
  /** Última conciliación diaria con la pasarela; null si aún no ha corrido o no se pudo leer. */
  gateway: GatewaySummary | null;
  /** Actividad de venta ahora (P1-22): con ella el runner de migraciones y los despliegues saben si es mal momento. null = no se pudo medir. */
  sales: SalesActivity | null;
  /** Obligaciones abiertas (P1-20): con ellas el panel se niega a apagar Entradas o Tienda con compradores a medias. null = no se pudo medir. */
  obligations: OpenObligations | null;
}

export interface OpenObligations {
  ticketOrdersPending: number;
  futureEventsWithTickets: number;
  cancelledEventsWithTickets: number;
  shopOrdersPending: number;
  shopOrdersToShip: number;
}

export interface SalesActivity {
  /** Pedidos de entradas Y de tienda creados en los últimos 15 minutos (cualquier estado): un lanzamiento de la tienda también es una venta. */
  orders15min: number;
  /** Personas en la sala de espera con turno vivo: ADMITTED con turno sin caducar, o WAITING que entraron hace menos de `WAITING_LIVE_MS`. Las filas viejas no cuentan (solo se cierran con tráfico de la cola, y una venta terminada no lo tiene). */
  waitingRoom: number;
}

const SALES_WINDOW_MS = 15 * 60_000;
/** Un WAITING más viejo que esto es casi seguro una pestaña cerrada: quien espera de verdad sondea cada pocos segundos y la cola avanza. */
const WAITING_LIVE_MS = 3 * 3_600_000;
/** Un pedido PENDING más viejo que esto es un pago abandonado (lo resuelve la conciliación), no un comprador esperando. */
const OBLIGATION_PENDING_MS = 24 * 3_600_000;
/** Un evento que empezó hace menos de esto sigue contando como «por venir»: la noche aún no ha terminado. */
const EVENT_ONGOING_MS = 12 * 3_600_000;

/** Tope de tiempo de TODO el bloque: el health lo lee el panel con un tiempo de espera corto. */
export const OPS_TIMEOUT_MS = 3000;
/** Un pendiente solo es señal si el sistema ya debía haberlo liberado (H-115): plazo de liberación (40 min) + 5 min de margen. Antes eran 20 min y cada abandono avisaba. */
const PENDING_OVER_MS = CHECKOUT_RELEASE_AFTER_MS + 5 * 60_000;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** Lee y valida el resultado de la conciliación con la pasarela; cualquier cosa rara = null. */
export function parseGatewaySummary(raw: string | null | undefined): GatewaySummary | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.lastRunAt !== 'string' || Number.isNaN(Date.parse(j.lastRunAt))) return null;
    const checked = num(j.checked);
    const unmatched = num(j.unmatched);
    const errors = num(j.errors);
    const skipped = num(j.skipped);
    if (checked === null || unmatched === null || errors === null || skipped === null) return null;
    return { lastRunAt: new Date(j.lastRunAt).toISOString(), checked, unmatched, errors, skipped, truncated: j.truncated === true };
  } catch {
    return null;
  }
}

/** Lee y valida el resumen del cron; cualquier cosa rara = null (nunca se propaga texto de la BD). */
export function parseReconcileSummary(raw: string | null | undefined): OpsBlock['reconcile'] {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const lastRunAt = typeof j.lastRunAt === 'string' && !Number.isNaN(Date.parse(j.lastRunAt)) ? new Date(j.lastRunAt).toISOString() : null;
    const errors = num(j.errors);
    const unknown = num(j.unknown);
    const processing = num(j.processing);
    const stuckOver24h = num(j.stuckOver24h);
    if (errors === null || unknown === null || processing === null || stuckOver24h === null) return null;
    return { lastRunAt, errors, unknown, processing, stuckOver24h };
  } catch {
    return null;
  }
}

/** Tope de CADA consulta del bloque (H-119): una consulta lenta (recuentos sobre tablas grandes en plena venta) se corta en el servidor en lugar de seguir ocupando una conexión del pool
 *  (`Promise.race` solo deja de ESPERAR, no cancela). Va como `SET LOCAL` de la transacción de cada medida: no toca ninguna otra conexión ni el resto de la app. */
export const OPS_STATEMENT_TIMEOUT_MS = 2000;
/** Cuánto se reutiliza el bloque (H-119): el panel lo pide cada 5 min por cliente, pero también lo piden la guarda del runner de migraciones y la de módulos; sin caché cada llamada son
 *  ~16 consultas sobre un pool pequeño compartido con el checkout. 30 s: lo que decide una guarda no queda desfasado más que eso. */
export const OPS_CACHE_MS = 30_000;

type Db = Pick<typeof prisma, 'order' | 'shopOrder' | 'event' | 'appConfig' | 'waitingRoomEntry' | '$queryRaw'>;

export async function collectOps(now = Date.now(), timeoutMs = OPS_TIMEOUT_MS): Promise<OpsBlock | null> {
  try {
    const out: OpsBlock = { generatedAt: new Date(now).toISOString(), pendingOldestMinutes: null, pendingOver20min: null, emailsUnsent: null, emailsFailed: null, reconcile: null, gateway: null, sales: null, obligations: null };
    let collected = 0;
    let expired = false;
    // Una medida que falla (o no llega a tiempo) deja su campo en null; las demás siguen. Cada medida va en SU transacción, con tope de sentencia, y las medidas van EN SERIE (H-119):
    // como mucho UNA conexión del pool a la vez (antes ~16 consultas simultáneas sobre un pool de 3 compartido con el checkout). Una sentencia cortada por el tope solo anula esa medida.
    const measure = (fn: (db: Db) => Promise<void>) => async () => {
      if (expired) return;
      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(OPS_STATEMENT_TIMEOUT_MS)}, true)`;
            await fn(tx as unknown as Db);
          },
          { maxWait: 1000, timeout: OPS_STATEMENT_TIMEOUT_MS + 1500 }
        );
        collected += 1;
      } catch {
        /* campo en null */
      }
    };
    // Pedidos con pago en una pasarela real (no la simulada) sin resolver.
    const gatewayPending = { status: 'PENDING' as const, paymentId: { not: null }, paymentProvider: { notIn: ['mock'] } };

    const steps: Array<() => Promise<void>> = [
      measure(async (db) => {
        // Solo los que ya pasaron su plazo (H-115): el «más antiguo» es lo que el panel convierte en alerta crítica.
        const overdue = { ...gatewayPending, createdAt: { lt: new Date(now - PENDING_OVER_MS) } };
        const o = await db.order.aggregate({ where: overdue, _min: { createdAt: true }, _count: true });
        const s = await db.shopOrder.aggregate({ where: overdue, _min: { createdAt: true }, _count: true });
        const oldest = [o._min.createdAt, s._min.createdAt].filter((d): d is Date => d instanceof Date).sort((a, b) => a.getTime() - b.getTime())[0];
        out.pendingOldestMinutes = oldest ? Math.max(0, Math.floor((now - oldest.getTime()) / 60_000)) : null;
        out.pendingOver20min = o._count + s._count;
      }),
      measure(async (db) => {
        const [a, b] = [await countEmailBacklog('entradas', { now, client: db }), await countEmailBacklog('tienda', { now, client: db })];
        out.emailsUnsent = a.unsent + b.unsent;
        out.emailsFailed = a.failed + b.failed;
      }),
      measure(async (db) => {
        const row = await db.appConfig.findUnique({ where: { key: OPS_RECONCILE_KEY }, select: { value: true } });
        out.reconcile = parseReconcileSummary(row?.value);
      }),
      measure(async (db) => {
        const row = await db.appConfig.findUnique({ where: { key: OPS_GATEWAY_KEY }, select: { value: true } });
        out.gateway = parseGatewaySummary(row?.value);
      }),
      measure(async (db) => {
        const since = { createdAt: { gte: new Date(now - SALES_WINDOW_MS) } };
        const tickets = await db.order.count({ where: since });
        const shop = await db.shopOrder.count({ where: since });
        const waitingRoom = await db.waitingRoomEntry.count({
          where: { OR: [{ status: 'ADMITTED', expiresAt: { gt: new Date(now) } }, { status: 'WAITING', joinedAt: { gte: new Date(now - WAITING_LIVE_MS) } }] },
        });
        out.sales = { orders15min: tickets + shop, waitingRoom };
      }),
      measure(async (db) => {
        const recent = { gte: new Date(now - OBLIGATION_PENDING_MS) };
        // PENDING reciente (un comprador a medio pago) O con un pago real en la pasarela sea cual sea su edad: un cobro sin pedido confirmado
        // es justo lo que apagar el módulo deja de conciliar. Un PENDING viejo sin pago real es un carrito abandonado y no cuenta.
        const pending = { status: 'PENDING' as const, OR: [{ createdAt: recent }, { paymentId: { not: null }, paymentProvider: { notIn: ['mock'] } }] };
        const validTickets = { tickets: { some: { status: 'VALID' as const } } };
        const ticketOrdersPending = await db.order.count({ where: pending });
        const futureEventsWithTickets = await db.event.count({ where: { status: 'PUBLISHED', date: { gte: new Date(now - EVENT_ONGOING_MS) }, ...validTickets } });
        const cancelledEventsWithTickets = await db.event.count({ where: { status: 'CANCELLED', ...validTickets } });
        const shopOrdersPending = await db.shopOrder.count({ where: pending });
        const shopOrdersToShip = await db.shopOrder.count({ where: { status: { in: ['PAID', 'PROCESSING'] } } });
        out.obligations = { ticketOrdersPending, futureEventsWithTickets, cancelledEventsWithTickets, shopOrdersPending, shopOrdersToShip };
      }),
    ];
    const work = (async () => {
      for (const step of steps) await step();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    if (timer) clearTimeout(timer);
    expired = true; // lo que no haya empezado, ya no empieza
    if (collected === 0) return null;
    // Lo que llegue tarde ya no se mira: se devuelve una copia de lo recogido hasta ahora.
    return { ...out };
  } catch {
    return null;
  }
}

const cache = new Map<string, { at: number; value: Promise<OpsBlock | null> }>();
const cacheKey = () => {
  try {
    return currentTenant()?.tenantId ?? 'single';
  } catch {
    return 'single';
  }
};

/** `collectOps` reutilizado `OPS_CACHE_MS` por cliente (y un solo cálculo a la vez: varios sondeos simultáneos comparten la misma promesa). Un resultado `null` NO se guarda: se reintenta en la
 *  siguiente llamada. Lo usa /api/health; `collectOps` (sin caché) queda para las pruebas. */
export function collectOpsCached(now = Date.now(), collect: (now: number) => Promise<OpsBlock | null> = collectOps): Promise<OpsBlock | null> {
  const key = cacheKey();
  const hit = cache.get(key);
  if (hit && now - hit.at < OPS_CACHE_MS && now >= hit.at) return hit.value;
  const value = collect(now);
  cache.set(key, { at: now, value });
  void value.then((v) => {
    if (v === null && cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** Solo para pruebas. */
export function resetOpsCacheForTests(): void {
  cache.clear();
}
