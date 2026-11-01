import { prisma } from '@/lib/prisma';

// `x-forwarded-for` es un header que el propio cliente puede mandar ya
// relleno (proxies estándar solo AÑADEN el IP real al final de la cadena,
// nunca limpian lo que ya viene puesto) — coger el primer valor deja que
// cualquiera se salte el rate-limit rotando ese header en cada petición.
// En Vercel, `x-vercel-forwarded-for` lo pone el propio edge de Vercel y
// sustituye cualquier valor que el cliente intente inyectar, así que es la
// única fuente fiable en producción; como red de seguridad si faltara, se
// usa el ÚLTIMO salto de `x-forwarded-for` (el más cercano a nuestra
// infraestructura, no el que el cliente puede falsificar).
export function getClientIp(request: Request): string {
  const h = request.headers;
  const vercelIp = h.get('x-vercel-forwarded-for');
  if (vercelIp) return vercelIp.split(',')[0]?.trim() || 'unknown';
  const fwd = h.get('x-forwarded-for');
  if (fwd) {
    const hops = fwd.split(',').map((v) => v.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return h.get('x-real-ip') || h.get('cf-connecting-ip') || 'unknown';
}

// NextAuth's `authorize(credentials, req)` passes a plain headers record, not a Web `Headers` instance.
// Mismo criterio de confianza que getClientIp: ver el comentario de arriba.
export function getClientIpFromHeaderRecord(headers: Record<string, string | string[] | undefined> | undefined): string {
  const vercel = headers?.['x-vercel-forwarded-for'];
  const vercelValue = Array.isArray(vercel) ? vercel[0] : vercel;
  if (vercelValue) return vercelValue.split(',')[0]?.trim() || 'unknown';
  const fwd = headers?.['x-forwarded-for'];
  const fwdValue = Array.isArray(fwd) ? fwd[0] : fwd;
  if (fwdValue) {
    const hops = fwdValue.split(',').map((v) => v.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  const real = headers?.['x-real-ip'];
  const realValue = Array.isArray(real) ? real[0] : real;
  return realValue || 'unknown';
}

export type RateLimitResult = { ok: boolean; remaining: number; retryAfter: number };

// Con una probabilidad baja en vez de en cada llamada: no hace falta que
// TODA petición pague el coste de este DELETE, solo que ocurra de vez en
// cuando para que la tabla no crezca sin límite con IPs que ya no vuelven.
function opportunisticCleanup(now: number) {
  if (Math.random() >= 0.01) return;
  prisma.rateLimitBucket
    .deleteMany({ where: { resetAt: { lt: new Date(now - 60 * 60_000) } } })
    .catch(() => {});
  // Los cupos de pedidos pendientes que ya caducaron (el pedido se pagó o se abandonó sin liberarlos): fuera, y con ellos la IP que guardaban (H-051).
  prisma.pendingSlot.deleteMany({ where: { expiresAt: { lt: new Date(now) } } }).catch(() => {});
}

// Antes esto era un Map en memoria del propio proceso. En Vercel serverless
// cada instancia tiene su memoria propia y se recicla en cada cold
// start/deploy — un límite "10 por minuto" en producción real se comportaba
// como "10 por minuto POR INSTANCIA viva", varias veces más permisivo de lo
// que la config sugiere, y se olvidaba de todo el mundo en cada deploy.
// Postgres ya es la única infraestructura del proyecto, así que un UPSERT
// atómico (sin necesidad de un advisory lock: el propio ON CONFLICT de
// Postgres serializa el incremento) da un límite real y compartido entre
// todas las instancias sin añadir Redis/Upstash.
export async function rateLimit(scope: string, identifier: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now();
  opportunisticCleanup(now);
  const key = `${scope}:${identifier}`;
  const resetAtIfNew = new Date(now + windowMs);

  const rows = await prisma.$queryRaw<{ count: number; resetAt: Date }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
    VALUES (${key}, 1, ${resetAtIfNew})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
      "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN excluded."resetAt" ELSE "RateLimitBucket"."resetAt" END
    RETURNING "count", "resetAt"
  `;
  const row = rows[0];

  if (row.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((row.resetAt.getTime() - now) / 1000)) };
  }
  return { ok: true, remaining: limit - row.count, retryAfter: 0 };
}

/**
 * Devuelve el hueco de UNA llamada anterior a `rateLimit` (resta 1, sin bajar de 0) y conserva el resto del cubo. Para el intento que SALIÓ BIEN:
 * un límite de intentos fallidos no debe gastarse con los correctos (H-061). Nunca lanza.
 */
export async function refundRateLimit(scope: string, identifier: string): Promise<void> {
  try {
    await prisma.$executeRaw`UPDATE "RateLimitBucket" SET "count" = GREATEST("count" - 1, 0) WHERE "key" = ${`${scope}:${identifier}`} AND "resetAt" > now()`;
  } catch (error) {
    console.error('[refundRateLimit]', error instanceof Error ? error.message : error);
  }
}

/** Devuelve el cupo de un `rateLimit` (borra su fila). Para quien toma el cupo antes de hacer el trabajo y el trabajo falla. Nunca lanza. */
export async function resetRateLimit(scope: string, identifier: string): Promise<void> {
  try {
    await prisma.rateLimitBucket.deleteMany({ where: { key: `${scope}:${identifier}` } });
  } catch (error) {
    console.error('[resetRateLimit]', error instanceof Error ? error.message : error);
  }
}

/* Cupo de pedidos PENDIENTES simultáneos (P0-04). No cuenta intentos por minuto (eso es `rateLimit`): cuenta los pedidos que esa IP tiene SIN
 * PAGAR ahora mismo. Cada pedido pendiente ocupa una fila de `PendingSlot` (H-051; antes, `RateLimitBucket` con claves de texto) que se libera al
 * pagarse, liberarse o anularse el pedido y que, en todo caso, caduca sola. El recuento y la inserción van dentro de la transacción de la compra, y
 * el LLAMANTE debe serializarlos con un cerrojo (`pg_advisory_xact_lock`): en entradas, el cerrojo del evento; en tienda, uno por IP. Sin cerrojo,
 * peticiones simultáneas leen el mismo recuento y se cuelan todas.
 *
 * Contar usa el índice (ámbito, identificador, caducidad) y liberar la clave primaria (el pedido): antes eran búsquedas por prefijo y sufijo de texto,
 * es decir, un escaneo de toda la tabla DENTRO del cerrojo de compra del evento.
 *
 * Es un freno contra scripts desde UNA sola IP, no una defensa completa: rotando IP (o con IPv6, donde cada dirección de un /64 cuenta como
 * distinta) se evade; la defensa real sería un captcha, que necesita claves del dueño. */
type SlotClient = Pick<typeof prisma, 'pendingSlot'>;

export async function countPendingSlots(client: SlotClient, scope: string, identifier: string): Promise<number> {
  return client.pendingSlot.count({ where: { scope, identifier, expiresAt: { gt: new Date() } } });
}

/** Reserva un hueco para el pedido `ref`. Idempotente por pedido. */
export async function takePendingSlot(client: SlotClient, scope: string, identifier: string, ref: string, ttlMs: number): Promise<void> {
  await client.pendingSlot.createMany({ data: [{ ref, scope, identifier, expiresAt: new Date(Date.now() + ttlMs) }], skipDuplicates: true });
}

/** Libera el hueco de un pedido (pagado, liberado o fallido). Nunca lanza: no es crítico, y el hueco caduca solo. */
export async function releasePendingSlot(ref: string): Promise<void> {
  try {
    await prisma.pendingSlot.deleteMany({ where: { ref } });
  } catch (error) {
    console.error('[releasePendingSlot]', error instanceof Error ? error.message : error);
  }
}
