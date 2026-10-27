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
