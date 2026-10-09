/* Log con límite de frecuencia (edge-safe). Una variable de entorno mal puesta o un registro caído hace fallar CADA petición: sin límite, el log
 * se inunda; sin log, el operador no se entera de por qué todos los clientes dan 503. Un mensaje por clave y por minuto. */

const MAX_KEYS = 500;
const g = globalThis as unknown as { __grailla_log_at?: Map<string, number> };

export function logRateLimited(key: string, message: string, opts: { everyMs?: number; now?: number; log?: (m: string) => void } = {}): boolean {
  const every = opts.everyMs ?? 60_000;
  const now = opts.now ?? Date.now();
  const seen = (g.__grailla_log_at ??= new Map());
  const last = seen.get(key);
  if (last !== undefined && now - last < every) return false;
  if (seen.size >= MAX_KEYS) {
    const oldest = seen.keys().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  seen.delete(key);
  seen.set(key, now);
  (opts.log ?? ((m: string) => console.error(m)))(message);
  return true;
}

/** Solo tests. */
export function resetLogRateLimitForTests(): void {
  g.__grailla_log_at = undefined;
}
