import { deriveCronSecret, parseMasterKey } from '@grailla/contracts';

/* Llamadas del panel al front de UN cliente (crons y salud). Siempre con el secreto de cron DE ESE cliente (derivado de
 * PLATFORM_CRON_MASTER + tenantId): una llamada a un cliente no sirve para otro.
 *
 * - No se siguen redirecciones: el secreto viaja en una cabecera y un 30x a otro dominio lo regalaría.
 * - Tiempo máximo por llamada; el cuerpo se limita en tamaño.
 * - Para desarrollo y tests, `TENANT_URL_TEMPLATE` (p. ej. `http://{host}:57811`) sustituye al `https://{host}` de producción. */

export type TenantTarget = { tenantId: string; host: string };
export type TenantCallResult = { status: number | null; body: unknown; text: string; durationMs: number; error: string | null };
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_BODY = 64 * 1024;

export function cronMaster(): Uint8Array {
  const raw = process.env.PLATFORM_CRON_MASTER;
  if (!raw) throw new Error('PLATFORM_CRON_MASTER no está definido: no se puede llamar a los crons de los clientes');
  return parseMasterKey(raw);
}

export function tenantUrl(host: string, pathAndQuery: string): string {
  const template = process.env.TENANT_URL_TEMPLATE || 'https://{host}';
  if (!template.includes('{host}')) throw new Error('TENANT_URL_TEMPLATE debe contener {host}');
  // El secreto del cliente viaja en una cabecera: en producción, jamás en claro.
  if (process.env.NODE_ENV === 'production' && !template.startsWith('https://')) throw new Error('En producción TENANT_URL_TEMPLATE debe ser https://');
  return `${template.replace('{host}', host)}${pathAndQuery}`;
}

export async function callTenant(
  target: TenantTarget,
  pathAndQuery: string,
  opts: { method?: 'GET' | 'POST'; timeoutMs?: number; fetchImpl?: FetchLike; now?: () => number } = {}
): Promise<TenantCallResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const done = (r: Omit<TenantCallResult, 'durationMs'>): TenantCallResult => ({ ...r, durationMs: now() - started });
  try {
    const secret = await deriveCronSecret(cronMaster(), target.tenantId);
    const res = await (opts.fetchImpl ?? fetch)(tenantUrl(target.host, pathAndQuery), {
      method: opts.method ?? 'GET',
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const text = (await res.text()).slice(0, MAX_BODY);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* no era JSON */
    }
    return done({ status: res.status, body, text, error: res.status >= 300 && res.status < 400 ? `Redirección ${res.status} no seguida` : null });
  } catch (err) {
    return done({ status: null, body: null, text: '', error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
  }
}
