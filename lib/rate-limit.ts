import { prisma } from '@/lib/prisma';

export function getClientIp(request: Request): string {
  const h = request.headers;
  const fwd = h.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || 'unknown';
  return h.get('x-real-ip') || h.get('cf-connecting-ip') || 'unknown';
}

// NextAuth's `authorize(credentials, req)` passes a plain headers record, not a Web `Headers` instance.
export function getClientIpFromHeaderRecord(headers: Record<string, string | string[] | undefined> | undefined): string {
  const fwd = headers?.['x-forwarded-for'];
  const fwdValue = Array.isArray(fwd) ? fwd[0] : fwd;
  if (fwdValue) return fwdValue.split(',')[0]?.trim() || 'unknown';
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
