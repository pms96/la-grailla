import { z } from 'zod';

/* Bloque `ops` de `GET /api/health` (P0-07): las señales de NEGOCIO que el panel vigila además de la salud técnica. Lo produce el front con
 * consultas indexadas, sin datos personales (solo contadores y marcas de tiempo), y solo en la respuesta con el secreto de cron del cliente.
 *
 * Compatibilidad (mismas reglas que el resto del contrato, ver README): el campo `ops` de la respuesta de salud es OPCIONAL. Un front
 * anterior que no lo manda sigue siendo válido (el panel no aplica reglas de negocio) y los campos que este esquema no conoce se ignoran,
 * así que el front puede añadir contadores sin romper a un panel antiguo. Es un cambio aditivo: no sube CONTRACT_VERSION. */

const count = z.number().finite().min(0);
const isoDate = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'fecha ISO no válida');

/** Última pasada del reconcile de pagos (la tarea que confirma o libera los pedidos pendientes) tal y como la dejó ese cliente. */
export const OpsReconcileSchema = z.object({
  /** Cuándo terminó la última pasada; null = no consta ninguna. */
  lastRunAt: isoDate.nullable(),
  /** Pedidos que dieron error en la última pasada (pasarela inalcanzable, credencial inválida…). */
  errors: count,
  /** De ellos, los que la pasarela no pudo confirmar ni descartar (siguen PENDING). */
  unknown: count,
  /** Cobros en curso en la pasarela (no es un fallo: se vuelven a mirar). */
  processing: count,
  /** Pedidos pendientes con más de 24 h: ya no se resuelven solos. */
  stuckOver24h: count,
});
export type OpsReconcile = z.infer<typeof OpsReconcileSchema>;

/** Última conciliación diaria pasarela↔BD (alerta nº 1 de la auditoría: «cobro sin pedido»). */
export const OpsGatewaySchema = z.object({
  /** Cuándo terminó la última pasada. */
  lastRunAt: isoDate,
  /** Cobros (o, en SumUp, pedidos sin pagar) contrastados. */
  checked: count,
  /** Cobros pagados en la pasarela sin pedido confirmado en la BD. Debe ser 0: cualquier valor es un incidente. */
  unmatched: count,
  /** Cuentas de cobro que no se pudieron consultar (credencial inválida, pasarela caída). */
  errors: count,
  /** Cuentas con cobertura parcial (SumUp no deja detectar cobros sin pedido). */
  skipped: count,
  /** La lista se cortó por tope de páginas o de tiempo. */
  truncated: z.boolean(),
});
export type OpsGateway = z.infer<typeof OpsGatewaySchema>;

/** Actividad de venta AHORA (P1-22): lo que decide si es buen momento para migrar o desplegar. Solo contadores, sin datos personales. */
export const OpsSalesSchema = z.object({
  /** Pedidos de entradas creados en los últimos 15 minutos (cualquier estado: un comprador en el checkout cuenta). */
  orders15min: count,
  /** Personas en la sala de espera (esperando o admitidas sin haber comprado todavía). */
  waitingRoom: count,
});
export type OpsSales = z.infer<typeof OpsSalesSchema>;

/** Pedidos en 15 min a partir de los cuales se considera «venta en marcha» aunque no haya sala de espera. */
export const SALES_BUSY_ORDERS_15MIN = 5;

/**
 * ¿Hay una venta en marcha? Sala de espera con gente, o un ritmo de pedidos sostenido. Es la señal con la que el runner de migraciones se
 * niega a tocar a un cliente (y con la que se decide congelar despliegues): una migración con bloqueos o un reinicio masivo en pleno
 * lanzamiento es justo lo que convierte «una venta» en «una caída». `null` (no se pudo medir) NO es «ocupado»: lo decide quien llama.
 */
export function isSalesWindowBusy(sales: OpsSales): boolean {
  return sales.waitingRoom > 0 || sales.orders15min >= SALES_BUSY_ORDERS_15MIN;
}

/** Obligaciones abiertas AHORA (P1-20): lo que impide apagar un módulo sin dejar a compradores colgados. Solo contadores, sin datos personales. */
export const OpsObligationsSchema = z.object({
  /** Pedidos de entradas PENDING de las últimas 24 h (un comprador a medio pago; los más viejos los resuelve la conciliación). */
  ticketOrdersPending: count,
  /** Eventos publicados que aún no han pasado (o empezaron hace menos de 12 h) con entradas válidas vendidas. */
  futureEventsWithTickets: count,
  /** Pedidos de tienda PENDING de las últimas 24 h. */
  shopOrdersPending: count,
  /** Pedidos de tienda pagados que todavía no se han enviado (PAID o PROCESSING). */
  shopOrdersToShip: count,
});
export type OpsObligations = z.infer<typeof OpsObligationsSchema>;

/** Módulos con obligaciones medibles hoy. Contabilidad y Wallets no dejan compradores esperando; Sponsors no tiene aún un modelo de cobro que medir. */
export type GuardedModule = 'entradas' | 'tienda';

/** Obligaciones abiertas que bloquean apagar `moduleKey`, en claro y con su cifra. Vacío = se puede apagar. */
export function moduleObligations(moduleKey: string, o: OpsObligations): string[] {
  const out: string[] = [];
  if (moduleKey === 'entradas') {
    if (o.ticketOrdersPending > 0) out.push(`${o.ticketOrdersPending} pedido(s) de entradas pendientes de pago`);
    if (o.futureEventsWithTickets > 0) out.push(`${o.futureEventsWithTickets} evento(s) por venir con entradas vendidas`);
  }
  if (moduleKey === 'tienda') {
    if (o.shopOrdersPending > 0) out.push(`${o.shopOrdersPending} pedido(s) de tienda pendientes de pago`);
    if (o.shopOrdersToShip > 0) out.push(`${o.shopOrdersToShip} pedido(s) de tienda pagados sin enviar`);
  }
  return out;
}

export const OpsBlockSchema = z.object({
  /** Cuándo se calculó el bloque (ISO). */
  generatedAt: isoDate,
  /** Minutos del pedido PENDING con pago en la pasarela más antiguo; null = no hay ninguno. */
  pendingOldestMinutes: count.nullable(),
  /** Pedidos PENDING con pago en la pasarela de más de 20 minutos. Null = no se pudo medir (el front no pudo ejecutar la consulta). */
  pendingOver20min: count.nullable(),
  /** Pedidos pagados cuyo email de confirmación sigue sin salir pasado el margen de gracia del front. Null = no se pudo medir. */
  emailsUnsent: count.nullable(),
  /** Pedidos pagados cuyo email falló (con `emailLastError`). Null = no se pudo medir. */
  emailsFailed: count.nullable(),
  /** Null = el cliente aún no ha registrado ninguna pasada. */
  reconcile: OpsReconcileSchema.nullable(),
  /** Conciliación diaria con la pasarela. Ausente = un front anterior que no la hace; null = aún no ha corrido. */
  gateway: OpsGatewaySchema.nullable().optional(),
  /** Actividad de venta ahora (P1-22). Ausente = un front anterior que no la mide; null = no se pudo medir. */
  sales: OpsSalesSchema.nullable().optional(),
  /** Obligaciones abiertas (P1-20). Ausente = un front anterior que no las mide; null = no se pudo medir. */
  obligations: OpsObligationsSchema.nullable().optional(),
});
export type OpsBlock = z.infer<typeof OpsBlockSchema>;

/** Lee el campo `ops` de una respuesta de salud. `absent` = el front no lo manda (versión anterior); `invalid` = lo manda y no cumple el contrato. */
export function parseOpsBlock(value: unknown): { status: 'absent' } | { status: 'invalid'; issue: string } | { status: 'ok'; ops: OpsBlock } {
  if (value === undefined || value === null) return { status: 'absent' };
  const parsed = OpsBlockSchema.safeParse(value);
  if (parsed.success) return { status: 'ok', ops: parsed.data };
  const first = parsed.error.issues[0];
  return { status: 'invalid', issue: `${first?.path.join('.') || 'ops'}: ${first?.message ?? 'no válido'}` };
}
