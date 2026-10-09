/* Almacén replicado de lectura que consulta el front. El panel es el único que
 * escribe. Lo que se guarda son snapshots firmados: aunque alguien manipulase el
 * almacén, el front rechazaría cualquier valor sin firma válida. */

export interface RegistryStore {
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

export class MemoryRegistryStore implements RegistryStore {
  readonly data = new Map<string, string>();
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Upstash Redis por REST (un comando por petición: ["SET", clave, valor]). */
export class UpstashRegistryStore implements RegistryStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly doFetch: FetchLike = fetch
  ) {}

  private async command(args: string[]): Promise<unknown> {
    const res = await this.doFetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      cache: 'no-store',
      // Se publica dentro de una transacción con un lock: un registro colgado no puede retenerlo 30 s.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`El registro respondió ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`El registro devolvió un error: ${json.error}`);
    return json.result;
  }

  async put(key: string, value: string) {
    const r = await this.command(['SET', key, value]);
    if (r !== 'OK') throw new Error('El registro no confirmó la escritura');
  }
  async del(key: string) {
    await this.command(['DEL', key]);
  }
  async get(key: string) {
    const r = await this.command(['GET', key]);
    return typeof r === 'string' ? r : null;
  }
}

let cached: RegistryStore | null = null;

/**
 * Qué almacén toca usar. `memory` solo existe para tests y desarrollo: en un servidor «publicaría» en la memoria de cada instancia, el front
 * no vería nada y todos los clientes darían 404 sin un solo error. Por eso en producción es un error, y también lo es no decir nada
 * (los scripts de `tsx` no llevan NODE_ENV: un `tenant:provision` sin REGISTRY_STORE publicaría en el vacío).
 */
export function resolveStoreKind(env: Record<string, string | undefined> = process.env): 'upstash' | 'memory' {
  const kind = env.REGISTRY_STORE;
  const production = env.NODE_ENV === 'production' || !!env.VERCEL;
  if (kind === 'upstash') return 'upstash';
  if (kind === 'memory') {
    if (production) throw new Error('REGISTRY_STORE=memory no vale en producción: publicaría en la memoria de cada instancia y el front no vería ningún cliente. Usa REGISTRY_STORE=upstash');
    return 'memory';
  }
  if (kind) throw new Error(`REGISTRY_STORE desconocido: ${kind}`);
  if (env.NODE_ENV === 'test' || env.NODE_ENV === 'development') return 'memory';
  throw new Error('REGISTRY_STORE no está definido: pon REGISTRY_STORE=upstash (con UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN)');
}

export function getRegistryStore(): RegistryStore {
  if (cached) return cached;
  const kind = resolveStoreKind();
  if (kind === 'upstash') {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN son obligatorios con REGISTRY_STORE=upstash');
    cached = new UpstashRegistryStore(url, token);
  } else {
    cached = new MemoryRegistryStore();
  }
  return cached;
}

/** Solo para tests: sustituye el almacén en uso. */
export function setRegistryStoreForTests(store: RegistryStore | null) {
  cached = store;
}
