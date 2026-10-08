import {
  registryKeyForHost,
  registryKeyForSecrets,
  normalizeHost,
  verifySecretsSnapshot,
  verifySnapshot,
  type SecretsSnapshotBody,
  type SnapshotBody,
} from '@grailla/contracts';
import type { TenantContext } from './context-types';

/* Resuelve un Host a su cliente leyendo el registro firmado. Edge-safe: solo fetch, WebCrypto y zod.
 *
 * - Cada valor del registro se verifica (firma Ed25519, dominio, producto, anti-replay): el almacén es un dato no fiable.
 * - Caché L1 en memoria de 15 s (con jitter), negativa de 30 s y single-flight: una ráfaga de peticiones al mismo Host
 *   cuesta UNA lectura, y un host desconocido no se puede usar para machacar el registro.
 * - Si el registro falla o devuelve algo inválido, se sigue sirviendo el último valor BUENO hasta MAX_STALE_SERVE_MS: una caída del
 *   plano de control o del almacén no apaga las webs de los clientes. */

export interface RegistryReader {
  get(key: string): Promise<string | null>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Lectura por REST de Upstash (un comando por petición). */
export class UpstashReader implements RegistryReader {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly doFetch: FetchLike = fetch
  ) {}

  async get(key: string): Promise<string | null> {
    const res = await this.doFetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key]),
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`El registro respondió ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`El registro devolvió un error: ${json.error}`);
    return typeof json.result === 'string' ? json.result : null;
  }
}

let readerOverride: RegistryReader | null = null;
/** Solo tests. */
export function setRegistryReaderForTests(reader: RegistryReader | null): void {
  readerOverride = reader;
}

export function getRegistryReader(): RegistryReader {
  if (readerOverride) return readerOverride;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN son obligatorios en modo plataforma');
  return new UpstashReader(url, token);
}

/** Claves públicas con las que se verifican los snapshots: SNAPSHOT_PUBKEYS = {kid: clave pública base64url}. Varias a la vez permiten rotar. */
function publicKeys(): Record<string, string> {
  try {
    const parsed = JSON.parse(process.env.SNAPSHOT_PUBKEYS ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const product = () => process.env.PLATFORM_PRODUCT || 'grailla';

export const L1_TTL_MS = 15_000;
export const NEGATIVE_TTL_MS = 30_000;
export const MAX_STALE_SERVE_MS = 6 * 3_600_000;
/** Tras un fallo del registro no se vuelve a intentar hasta pasado este tiempo (con jitter): una caída no multiplica las lecturas. */
export const RETRY_BACKOFF_MS = 5_000;
/** Tope de hosts recordados en las cachés negativa y de fallo: un dominio comodín no puede inflar la memoria. */
export const MAX_TRACKED_HOSTS = 10_000;
/** Lecturas al registro por instancia para hosts SIN caché (los desconocidos): ráfaga y recarga por segundo. */
export const LOOKUP_BURST = 100;
export const LOOKUP_REFILL_PER_SEC = 20;

export type Resolution =
  | { status: 'ok'; ctx: Omit<TenantContext, 'host'>; stale: boolean }
  | { status: 'not_found' }
  | { status: 'unavailable'; reason: string };

type Good = { ctx: Omit<TenantContext, 'host'>; secrets: SecretsSnapshotBody; fetchedAt: number; routingSeq: number; retryAt?: number };
type State = {
  good: Map<string, Good>;
  negative: Map<string, number>;
  failed: Map<string, { until: number; reason: string }>;
  inflight: Map<string, Promise<Resolution>>;
  /** Último `seq` de enrutado visto por suscripción (`tenantId|producto`): el `seq` es por cliente, no por host. */
  lastRoutingSeq: Map<string, number>;
  lastSecretsSeq: Map<string, number>;
  bucket: { tokens: number; at: number };
};
const g = globalThis as unknown as { __grailla_tenant_l1?: State };
const state = (): State =>
  (g.__grailla_tenant_l1 ??= {
    good: new Map(),
    negative: new Map(),
    failed: new Map(),
    inflight: new Map(),
    lastRoutingSeq: new Map(),
    lastSecretsSeq: new Map(),
    bucket: { tokens: LOOKUP_BURST, at: 0 },
  });

/** Solo tests. */
export function resetResolverStateForTests(): void {
  g.__grailla_tenant_l1 = undefined;
}

const jitter = (ms: number) => Math.round(ms * (0.85 + Math.random() * 0.3));

/** Inserta con tope: si el mapa está lleno se descarta lo más antiguo (orden de inserción). */
function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  if (map.size >= MAX_TRACKED_HOSTS) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

function takeLookupToken(st: State, now: number): boolean {
  const b = st.bucket;
  if (b.at === 0) b.at = now;
  b.tokens = Math.min(LOOKUP_BURST, b.tokens + Math.max(0, now - b.at) / 1000 * LOOKUP_REFILL_PER_SEC);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function toContext(body: SnapshotBody, secrets: SecretsSnapshotBody): Omit<TenantContext, 'host'> {
  const r = body.record;
  return {
    tenantId: r.tenantId,
    product: r.product,
    primaryDomain: r.primaryDomain,
    epoch: r.epoch,
    status: r.status,
    modules: r.modules,
    db: { pooledEnc: secrets.dbUrlPooledEnc, directEnc: secrets.dbUrlDirectEnc },
  };
}

async function fetchAndVerify(host: string, now: number): Promise<Resolution> {
  const st = state();
  const cached = st.good.get(host);
  // Cliente que ya verificó este intento (si el enrutado llegó a verificarse): jamás se sirve como obsoleto el contexto de OTRO cliente.
  let verifiedTenant: string | null = null;
  const serveStale = (reason: string): Resolution => {
    const sameTenant = !verifiedTenant || cached?.ctx.tenantId === verifiedTenant;
    if (cached && sameTenant && now - cached.fetchedAt <= MAX_STALE_SERVE_MS) {
      cached.retryAt = now + jitter(RETRY_BACKOFF_MS);
      // Visible en los logs: servir obsoleto por una firma que no se puede verificar (rotación mal desplegada, almacén manipulado)
      // no debe pasar en silencio, porque una suspensión publicada no se aplicaría.
      console.error(`[tenant-resolve] sirviendo obsoleto ${host}: ${reason}`);
      return { status: 'ok', ctx: cached.ctx, stale: true };
    }
    setBounded(st.failed, host, { until: now + jitter(RETRY_BACKOFF_MS), reason });
    return { status: 'unavailable', reason };
  };

  const reader = getRegistryReader();
  const keys = publicKeys();
  try {
    const rawRouting = await reader.get(registryKeyForHost(host));
    if (rawRouting === null) {
      // El dominio ya no está en el registro (liberado o borrado): deja de servirse, aunque hubiera caché.
      st.good.delete(host);
      setBounded(st.negative, host, now + jitter(NEGATIVE_TTL_MS));
      return { status: 'not_found' };
    }
    // El anti-replay se comprueba DESPUÉS de verificar, con el cliente que firma el snapshot: el `seq` es por suscripción,
    // y un dominio que pasa de un cliente a otro no puede compararse con el `seq` del anterior.
    const routing = await verifySnapshot(JSON.parse(rawRouting), { keys, host, product: product(), now });
    if (!routing.ok) return serveStale(`snapshot de enrutado no válido (${routing.reason})`);

    const { tenantId } = routing.body.record;
    verifiedTenant = tenantId;
    const subscription = `${tenantId}|${routing.body.record.product}`;
    const lastRouting = st.lastRoutingSeq.get(subscription);
    if (lastRouting != null && routing.body.seq < lastRouting) return serveStale('snapshot de enrutado no válido (replay)');

    const secretsKey = registryKeyForSecrets(tenantId, routing.body.record.product);
    const rawSecrets = await reader.get(secretsKey);
    if (rawSecrets === null) return serveStale('no hay secretos publicados para este cliente');
    const secrets = await verifySecretsSnapshot(JSON.parse(rawSecrets), {
      keys,
      tenantId,
      product: routing.body.record.product,
      lastSeq: st.lastSecretsSeq.get(subscription) ?? null,
    });
    if (!secrets.ok) return serveStale(`snapshot de secretos no válido (${secrets.reason})`);

    st.lastRoutingSeq.set(subscription, routing.body.seq);
    st.lastSecretsSeq.set(subscription, secrets.body.seq);
    st.failed.delete(host);
    const ctx = toContext(routing.body, secrets.body);
    setBounded(st.good, host, { ctx, secrets: secrets.body, fetchedAt: now, routingSeq: routing.body.seq });
    return { status: 'ok', ctx, stale: routing.stale };
  } catch (err) {
    return serveStale(err instanceof Error ? err.message : 'el registro no responde');
  }
}

export async function resolveHost(rawHost: string, now: number = Date.now()): Promise<Resolution> {
  const host = normalizeHost(rawHost);
  if (!host) return { status: 'not_found' };
  const st = state();

  const hit = st.good.get(host);
  if (hit && now - hit.fetchedAt < jitter(L1_TTL_MS)) return { status: 'ok', ctx: hit.ctx, stale: false };
  // Modo degradado: si la última lectura falló, se sirve lo último bueno sin esperar a un registro que no responde.
  if (hit?.retryAt && now < hit.retryAt && now - hit.fetchedAt <= MAX_STALE_SERVE_MS) return { status: 'ok', ctx: hit.ctx, stale: true };
  const neg = st.negative.get(host);
  if (neg) {
    if (neg > now) return { status: 'not_found' };
    st.negative.delete(host);
  }
  const failed = st.failed.get(host);
  if (failed) {
    if (failed.until > now) return { status: 'unavailable', reason: failed.reason };
    st.failed.delete(host);
  }

  // Single-flight: las peticiones simultáneas al mismo host comparten una sola lectura.
  let pending = st.inflight.get(host);
  if (!pending) {
    // Un host sin caché cuesta una lectura al registro: se limita la tasa para que un dominio comodín no agote la cuota.
    if (!hit && !takeLookupToken(st, now)) return { status: 'unavailable', reason: 'demasiadas búsquedas de hosts desconocidos' };
    pending = fetchAndVerify(host, now).finally(() => st.inflight.delete(host));
    st.inflight.set(host, pending);
  }
  return pending;
}
