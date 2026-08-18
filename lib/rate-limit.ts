type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function cleanup(now: number) {
  if (buckets.size < 5000) return;
  buckets.forEach((v, k) => {
    if (v.resetAt <= now) buckets.delete(k);
  });
}

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

export function rateLimit(scope: string, identifier: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  cleanup(now);
  const key = scope + ':' + identifier;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }

  if (existing.count >= limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }

  existing.count += 1;
  return { ok: true, remaining: limit - existing.count, retryAfter: 0 };
}
