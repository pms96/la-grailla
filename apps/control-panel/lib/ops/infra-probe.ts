import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { redactUrls, withConnectionLockTimeout } from '../migrations/executor';

/* Sondas de la Fase 1: lo que no se puede saber leyendo el código, solo midiéndolo contra la infraestructura REAL (Neon, Upstash,
 * Vercel). Cada sonda devuelve una lista de comprobaciones con veredicto; ninguna deja datos (la única escritura es una clave
 * `__probe__:*` en Upstash con caducidad, que se borra al terminar) y ninguna imprime una URL de BD ni un token.
 *
 * Los números de latencia desde un portátil NO son los de Vercel: sirven para detectar órdenes de magnitud, no para fijar presupuestos. */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info' | 'skip';
export type Check = { id: string; status: CheckStatus; title: string; detail?: string };
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (id: string, status: CheckStatus, title: string, detail?: string): Check => ({ id, status, title, detail });

export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const ms = (n: number) => `${Math.round(n)} ms`;

/** Quita URLs de conexión y cualquier valor secreto conocido de un texto antes de mostrarlo. */
export function scrub(text: string, secrets: string[] = []): string {
  let out = redactUrls(text);
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[oculto]');
  return out;
}

export function hasFailures(checks: Check[]): boolean {
  return checks.some((c) => c.status === 'fail');
}

export function formatReport(checks: Check[], secrets: string[] = []): string {
  const icon: Record<CheckStatus, string> = { pass: '✓', fail: '✗', warn: '!', info: '·', skip: '-' };
  const lines = checks.map((c) => `${icon[c.status]} ${scrub(c.title, secrets)}${c.detail ? `\n    ${scrub(c.detail, secrets).replace(/\n/g, '\n    ')}` : ''}`);
  const n = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  lines.push('', `${n('pass')} bien, ${n('fail')} fallan, ${n('warn')} avisos, ${n('skip')} omitidas.`);
  return lines.join('\n');
}

/* ───────────────────────────── BD (Neon) ───────────────────────────── */

type Db = PrismaClient;
const open = (url: string): Db => new PrismaClient({ datasourceUrl: url, log: [] });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function timeQuery(db: Db): Promise<number> {
  const t = Date.now();
  await db.$queryRawUnsafe('SELECT 1');
  return Date.now() - t;
}

/** Una transacción que toma un lock de asesoramiento y lo retiene `holdMs`. Devuelve cuándo lo obtuvo. */
async function holdAdvisory(db: Db, k1: number, k2: number, holdMs: number): Promise<number> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${k1}::int, ${k2}::int)`);
      const acquiredAt = Date.now();
      if (holdMs > 0) await sleep(holdMs);
      return acquiredAt;
    },
    { timeout: holdMs + 15_000, maxWait: 15_000 }
  );
}

export type DatabaseProbeOptions = {
  directUrl: string;
  /** La URL pooled (pgbouncer) de la misma BD: se prueba que los locks de asesoramiento serializan a través de ella. */
  pooledUrl?: string;
  lockTimeoutMs?: number;
  samples?: number;
  /** Segundos de inactividad antes de medir una consulta «en frío» (scale-to-zero de Neon). Omitir = no medir. */
  coldStartIdleSeconds?: number;
};

export async function probeDatabase(opts: DatabaseProbeOptions): Promise<Check[]> {
  const out: Check[] = [];
  const lockMs = opts.lockTimeoutMs ?? 3000;
  const samples = opts.samples ?? 20;
  const direct = open(opts.directUrl);
  try {
    // 1 · Conexión y latencia (la primera consulta puede incluir el arranque de la BD).
    let first: number;
    try {
      first = await timeQuery(direct);
    } catch (e) {
      return [check('db.connect', 'fail', 'No se puede abrir la BD con la URL directa', errText(e))];
    }
    const warm: number[] = [];
    for (let i = 0; i < samples; i++) warm.push(await timeQuery(direct));
    out.push(check('db.latency', 'info', `Latencia desde aquí: primera consulta ${ms(first)}, después p50 ${ms(percentile(warm, 50))} / p95 ${ms(percentile(warm, 95))}`, 'Desde un portátil, no desde Vercel: sirve para el orden de magnitud.'));

    const [meta] = await direct.$queryRawUnsafe<{ version: string; db: string; maxc: string }[]>(
      `SELECT version() AS version, current_database() AS db, current_setting('max_connections') AS maxc`
    );
    out.push(check('db.server', 'info', `${meta.version.split(' on ')[0]}, BD «${meta.db}», max_connections ${meta.maxc}`));

    // 2 · El `lock_timeout` de arranque llega a la conexión (y SOLO a la del runner).
    const withOpt = open(withConnectionLockTimeout(opts.directUrl, lockMs));
    try {
      const [{ lock_timeout: got }] = await withOpt.$queryRawUnsafe<{ lock_timeout: string }[]>('SHOW lock_timeout');
      const [{ lock_timeout: plain }] = await direct.$queryRawUnsafe<{ lock_timeout: string }[]>('SHOW lock_timeout');
      const want = `${lockMs / 1000}s`;
      if (got === want || got === `${lockMs}ms`) out.push(check('db.lock-timeout-option', 'pass', `El endpoint directo respeta «options=-c lock_timeout» (la conexión del runner ve ${got})`));
      else out.push(check('db.lock-timeout-option', 'fail', `El lock_timeout de arranque NO llegó a la conexión (vale ${got}, se esperaba ${want})`, 'Plan B: MIGRATION_LOCK_TIMEOUT_MODE=database (ver docs/platform/m7-operacion.md).'));
      if (plain === got && got !== '0') out.push(check('db.lock-timeout-scope', 'fail', `Las conexiones normales también tienen lock_timeout=${plain}: el valor está puesto en la BD o el rol`, 'Las ventas y la taquilla esperarían bloqueos solo ese tiempo.'));
      else out.push(check('db.lock-timeout-scope', 'pass', `Las conexiones normales no se ven afectadas (lock_timeout ${plain})`));
    } catch (e) {
      out.push(check('db.lock-timeout-option', 'fail', 'El endpoint directo rechazó el parámetro de arranque «options»', `${errText(e).slice(-300)}\nPlan B: MIGRATION_LOCK_TIMEOUT_MODE=database.`));
    } finally {
      await withOpt.$disconnect();
    }

    // 3 · El lock_timeout corta de verdad una espera (con un lock de asesoramiento propio: sin tocar ninguna tabla).
    const [k1, k2] = [2026_1009, crypto.randomInt(1, 2 ** 30)];
    const waiter = open(withConnectionLockTimeout(opts.directUrl, 1000));
    try {
      const holder = holdAdvisory(direct, k1, k2, 2500).catch((e) => e);
      await sleep(400);
      const t = Date.now();
      let outcome: 'timeout' | 'acquired' | 'other' = 'acquired';
      let otherMsg = '';
      try {
        await waiter.$transaction(async (tx) => tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${k1}::int, ${k2}::int)`), { timeout: 10_000, maxWait: 10_000 });
      } catch (e) {
        const text = `${errText(e)} ${JSON.stringify((e as { meta?: unknown }).meta ?? '')}`;
        outcome = /55P03|lock timeout/i.test(text) ? 'timeout' : 'other';
        otherMsg = text.slice(-200);
      }
      const waited = Date.now() - t;
      await holder;
      if (outcome === 'timeout' && waited >= 700 && waited <= 2300) out.push(check('db.lock-timeout-effect', 'pass', `Una espera de bloqueo se corta a ${ms(waited)} (lock_timeout de 1 s)`));
      else if (outcome === 'timeout') out.push(check('db.lock-timeout-effect', 'warn', `Se cortó, pero a ${ms(waited)} (se esperaba ~1000 ms)`));
      else out.push(check('db.lock-timeout-effect', 'fail', outcome === 'acquired' ? 'La espera no se cortó: el lock_timeout no está actuando' : 'La espera falló por otro motivo', otherMsg));
    } finally {
      await waiter.$disconnect();
    }

    // 4 · Locks de asesoramiento a través de la URL pooled (las ventas serializan con `pg_advisory_xact_lock` en transacciones interactivas).
    if (opts.pooledUrl) {
      const a = open(opts.pooledUrl);
      const b = open(opts.pooledUrl);
      try {
        const q1 = 2026_1010;
        const q2 = crypto.randomInt(1, 2 ** 30);
        const hold = 1500;
        const holder = holdAdvisory(a, q1, q2, hold);
        await sleep(300);
        const t = Date.now();
        const secondAcquired = await holdAdvisory(b, q1, q2, 0);
        const firstAcquired = await holder;
        const waited = secondAcquired - t;
        if (secondAcquired >= firstAcquired + hold * 0.8) out.push(check('db.pooled-advisory', 'pass', `Por la URL pooled, el lock de asesoramiento serializa (la segunda transacción esperó ${ms(waited)})`));
        else out.push(check('db.pooled-advisory', 'fail', `Por la URL pooled, dos transacciones tuvieron el mismo lock a la vez (la segunda esperó solo ${ms(waited)})`, 'La venta de la última entrada podría sobrevenderse. No sirve este modo de pool para el front.'));
      } catch (e) {
        out.push(check('db.pooled-advisory', 'fail', 'No se pudo probar el lock por la URL pooled', errText(e).slice(-300)));
      } finally {
        await Promise.all([a.$disconnect(), b.$disconnect()]);
      }
    } else out.push(check('db.pooled-advisory', 'skip', 'Locks por la URL pooled: no se indicó --pooled-env'));

    // 5 · Arranque en frío (opcional: espera la inactividad que pide Neon para suspender el cómputo).
    if (opts.coldStartIdleSeconds) {
      await direct.$disconnect();
      await sleep(opts.coldStartIdleSeconds * 1000);
      const cold = open(opts.directUrl);
      try {
        const t = await timeQuery(cold);
        out.push(check('db.cold-start', t > 1500 ? 'warn' : 'info', `Primera consulta tras ${opts.coldStartIdleSeconds} s de inactividad: ${ms(t)}`, t > 1500 ? 'La BD estaba suspendida: la primera visita tras un rato sin tráfico pagará este arranque.' : 'La BD no se había suspendido (¿el cron de 5 min la mantiene despierta?).'));
      } finally {
        await cold.$disconnect();
      }
    }
  } finally {
    await direct.$disconnect().catch(() => undefined);
  }
  return out;
}

/* ───────────────────────────── Registro (Upstash) ───────────────────────────── */

export type RegistryProbeOptions = {
  url: string;
  writeToken: string;
  readOnlyToken: string;
  samples?: number;
  fetch?: FetchFn;
};

type Reply = { ok: boolean; status: number; result?: unknown; error?: string };

export async function probeRegistry(opts: RegistryProbeOptions): Promise<Check[]> {
  const doFetch = opts.fetch ?? fetch;
  const out: Check[] = [];
  const samples = opts.samples ?? 20;
  const call = async (token: string, cmd: string[]): Promise<Reply> => {
    const res = await doFetch(opts.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    return { ok: res.ok && !body.error, status: res.status, result: body.result, error: body.error };
  };

  const u = new URL(opts.url);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  out.push(u.protocol === 'https:' ? check('reg.https', 'pass', 'El registro se sirve por https') : loopback ? check('reg.https', 'info', 'El registro es local (sin https): solo para desarrollo') : check('reg.https', 'fail', `El registro usa ${u.protocol} (los tokens viajarían sin cifrar)`));

  const key = `__probe__:${crypto.randomBytes(6).toString('hex')}`;
  try {
    const set = await call(opts.writeToken, ['SET', key, 'ok', 'EX', '120']);
    out.push(set.ok && set.result === 'OK' ? check('reg.write', 'pass', 'El token de escritura escribe') : check('reg.write', 'fail', 'El token de escritura no pudo escribir', `HTTP ${set.status} ${set.error ?? ''}`));
    if (!set.ok) return out;

    const get = await call(opts.readOnlyToken, ['GET', key]);
    out.push(get.ok && get.result === 'ok' ? check('reg.read-only-read', 'pass', 'El token de solo lectura lee') : check('reg.read-only-read', 'fail', 'El token de solo lectura no pudo leer', `HTTP ${get.status} ${get.error ?? ''}`));

    const set2 = await call(opts.readOnlyToken, ['SET', key, 'hackeado']);
    const del2 = await call(opts.readOnlyToken, ['DEL', key]);
    const after = await call(opts.writeToken, ['GET', key]);
    if (set2.ok || del2.ok || after.result !== 'ok') out.push(check('reg.read-only-write', 'fail', 'El token «de solo lectura» PUEDE escribir o borrar', 'Quien comprometiera el front podría reponer snapshots antiguos o quitar una revocación. Usa el «Read-Only Token» de la consola de Upstash.'));
    else out.push(check('reg.read-only-write', 'pass', 'El token de solo lectura no puede escribir ni borrar'));

    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const t = Date.now();
      await call(opts.readOnlyToken, ['GET', key]);
      times.push(Date.now() - t);
    }
    out.push(check('reg.latency', 'info', `Lectura REST desde aquí: p50 ${ms(percentile(times, 50))} / p95 ${ms(percentile(times, 95))}`, 'Desde un portátil, no desde Vercel.'));

    // «Una base por entorno»: si hay claves que no son de la plataforma, la base se comparte con otra cosa.
    const scan = await call(opts.readOnlyToken, ['SCAN', '0', 'COUNT', '500']);
    if (scan.ok && Array.isArray(scan.result) && Array.isArray(scan.result[1])) {
      const keys = scan.result[1] as string[];
      const foreign = keys.filter((k) => !/^(h:|s:|revoked:|__probe__:)/.test(k));
      out.push(foreign.length ? check('reg.foreign-keys', 'warn', `La base tiene ${foreign.length} claves que no son de la plataforma (p. ej. «${foreign[0].slice(0, 12)}…»)`, 'Una base de Upstash por entorno y solo para el registro.') : check('reg.foreign-keys', 'pass', `Solo hay claves del registro (${keys.filter((k) => !k.startsWith('__probe__:')).length} h:/s:/revoked:)`));
    } else out.push(check('reg.foreign-keys', 'skip', 'No se pudo listar las claves (SCAN no disponible con este token)'));
  } finally {
    await call(opts.writeToken, ['DEL', key]).catch(() => undefined);
  }
  return out;
}

/* ───────────────────────────── Dominios y caché (Vercel) ───────────────────────────── */

export type HostsProbeOptions = {
  /** Un origen por cliente de prueba: `https://a.ejemplo.es`. Debe haber al menos dos para comprobar el aislamiento. */
  origins: string[];
  paths?: string[];
  /** Los orígenes son la misma marca (no se exige que se vean distintos). */
  sameTenant?: boolean;
  /** Región esperada de las funciones (`fra1`). */
  region?: string;
  /** Un dominio apuntado al despliegue pero NO dado de alta: debe dar 404. */
  unknownOrigin?: string;
  /** La URL de un despliegue de vista previa: debe dar 404. */
  previewOrigin?: string;
  fetch?: FetchFn;
};

type Seen = { status: number; headers: Headers; body: string };
const titleOf = (html: string) => /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1].trim().replace(/\s+/g, ' ') ?? '';
/** `x-vercel-id: cdg1::fra1::abc` → la región que ejecutó la función. Una respuesta de caché solo lleva la del borde. */
function functionRegion(id: string | null): string | null {
  const parts = (id ?? '').split('::');
  return parts.length >= 3 ? parts[1] : null;
}

/** Rutas públicas que el front deja cachear 60 s en el CDN de Vercel (next.config.js, `Vercel-CDN-Cache-Control`). Un HIT ahí es lo esperado. */
const CDN_CACHED_PATHS = new Set(['/', '/eventos', '/tienda', '/sponsors']);

export async function probeHosts(opts: HostsProbeOptions): Promise<Check[]> {
  const doFetch = opts.fetch ?? fetch;
  const out: Check[] = [];
  const paths = opts.paths ?? ['/', '/api/health', '/robots.txt', '/sitemap.xml'];
  const get = async (origin: string, path: string): Promise<Seen> => {
    const res = await doFetch(new URL(path, origin).toString(), { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    return { status: res.status, headers: res.headers, body: (await res.text()).slice(0, 300_000) };
  };

  // Dos vueltas intercaladas (A, B, A, B): si el CDN guardara una página sin distinguir el Host, la segunda vuelta serviría la del otro.
  const rounds: Record<string, Record<string, Seen>>[] = [];
  for (let r = 0; r < 2; r++) {
    const round: Record<string, Record<string, Seen>> = {};
    for (const origin of opts.origins) {
      round[origin] = {};
      for (const p of paths) {
        try {
          round[origin][p] = await get(origin, p);
        } catch (e) {
          out.push(check(`host.fetch.${origin}${p}`, 'fail', `${origin}${p}: no responde`, errText(e)));
        }
      }
    }
    rounds.push(round);
  }

  const titles = new Map<string, string>();
  for (const origin of opts.origins) {
    for (const p of paths) {
      const seen = rounds.map((r) => r[origin]?.[p]).filter((s): s is Seen => !!s);
      if (!seen.length) continue;
      const bad = seen.find((s) => s.status >= 400 || s.status === 0);
      out.push(bad ? check(`host.status.${origin}${p}`, 'fail', `${origin}${p} responde ${bad.status}`) : check(`host.status.${origin}${p}`, 'pass', `${origin}${p} responde ${seen[0].status}`));
      const cc = seen[0].headers.get('cache-control');
      const vc = seen.map((s) => s.headers.get('x-vercel-cache')).join('/');
      out.push(check(`host.cache.${origin}${p}`, 'info', `${origin}${p}: cache-control «${cc ?? '—'}», x-vercel-cache ${vc || '—'}`));
      if (/private|no-store/i.test(cc ?? '') && seen.some((s) => /^(HIT|STALE)$/i.test(s.headers.get('x-vercel-cache') ?? ''))) {
        // Las páginas públicas piden 60 s de caché al CDN A PROPÓSITO (`Vercel-CDN-Cache-Control` en next.config.js; Vercel quita esa
        // cabecera de la respuesta, así que desde fuera solo se ve el `private` del navegador). Ahí un HIT es lo esperado: lo que habría que
        // detectar es que mezcle dominios, y eso lo comprueban el título estable y la marca distinta entre rondas intercaladas.
        // En cualquier otra ruta (API, robots…) un HIT sí es un fallo.
        out.push(
          CDN_CACHED_PATHS.has(p)
            ? check(`host.cache-cdn.${origin}${p}`, 'info', `${origin}${p}: el CDN la sirvió de caché (esperado: 60 s, con el dominio en la clave)`)
            : check(`host.cache-leak.${origin}${p}`, 'fail', `${origin}${p} declara «${cc}» y aun así el CDN la sirvió de caché`)
        );
      }
      if (p === '/') {
        const [t0, t1] = seen.map((s) => titleOf(s.body));
        titles.set(origin, t0);
        out.push(t1 === undefined || t0 === t1 ? check(`host.title-stable.${origin}`, 'pass', `${origin}: el título es estable entre peticiones («${t0.slice(0, 50)}»)`) : check(`host.title-stable.${origin}`, 'fail', `${origin}: el título cambió entre dos peticiones («${t0.slice(0, 40)}» → «${t1.slice(0, 40)}»)`, 'Con peticiones intercaladas entre dos dominios, eso es la señal de una caché que mezcla Hosts.'));
        if (seen[0].headers.get('set-cookie')) out.push(check(`host.cookie.${origin}`, 'warn', `${origin}/ envía Set-Cookie en una lectura pública`, 'Una respuesta con cookie no debería ir a la caché compartida.'));
      }
      if (p === '/api/health') {
        const keys = (() => {
          try {
            return Object.keys(JSON.parse(seen[0].body));
          } catch {
            return ['(no es JSON)'];
          }
        })();
        out.push(keys.every((k) => k === 'status') ? check(`host.health-public.${origin}`, 'pass', `${origin}/api/health público solo devuelve «status»`) : check(`host.health-public.${origin}`, 'fail', `${origin}/api/health público devuelve más que «status»: ${keys.join(', ')}`));
        const region = functionRegion(seen[0].headers.get('x-vercel-id'));
        if (opts.region) out.push(region === null ? check(`host.region.${origin}`, 'warn', `No se pudo leer la región de las funciones (x-vercel-id sin región)`) : region === opts.region ? check(`host.region.${origin}`, 'pass', `Las funciones corren en ${region}`) : check(`host.region.${origin}`, 'fail', `Las funciones corren en ${region}, se esperaba ${opts.region}`));
      }
    }
  }

  if (!opts.sameTenant && opts.origins.length > 1) {
    const distinct = new Set([...titles.values()]);
    out.push(distinct.size === titles.size && ![...titles.values()].includes('') ? check('host.distinct', 'pass', `Cada dominio muestra su propia marca (${[...titles.values()].map((t) => `«${t.slice(0, 30)}»`).join(', ')})`) : check('host.distinct', 'fail', 'Dos dominios muestran el mismo título', 'O es la misma marca (usa --same-tenant) o el CDN mezcla Hosts.'));
  }

  // Un sitemap o un robots con el dominio de OTRO cliente es una mezcla de datos.
  for (const origin of opts.origins) {
    for (const p of ['/robots.txt', '/sitemap.xml']) {
      const body = rounds[0][origin]?.[p]?.body;
      if (body === undefined) continue;
      const mine = new URL(origin).host;
      const foreign = opts.origins.map((o) => new URL(o).host).filter((h) => h !== mine && body.includes(h));
      out.push(foreign.length ? check(`host.foreign.${origin}${p}`, 'fail', `${origin}${p} nombra a otro cliente: ${foreign.join(', ')}`) : check(`host.foreign.${origin}${p}`, 'pass', `${origin}${p} no nombra a otros clientes`));
    }
  }

  for (const [label, origin] of [['desconocido', opts.unknownOrigin], ['preview', opts.previewOrigin]] as const) {
    if (!origin) continue;
    try {
      const s = await get(origin, '/');
      out.push(s.status === 404 ? check(`host.${label}`, 'pass', `El dominio ${label} (${new URL(origin).host}) responde 404`) : check(`host.${label}`, 'fail', `El dominio ${label} (${new URL(origin).host}) responde ${s.status}, se esperaba 404`));
    } catch (e) {
      out.push(check(`host.${label}`, 'fail', `El dominio ${label} no responde`, errText(e)));
    }
  }
  return out;
}

/* ───────────────────────────── Disparador de tareas (panel) ───────────────────────────── */

export type CronProbeOptions = { panelUrl: string; secret: string; fetch?: FetchFn };

export async function probeCron(opts: CronProbeOptions): Promise<Check[]> {
  const doFetch = opts.fetch ?? fetch;
  const out: Check[] = [];
  const url = (job: string) => new URL(`/api/cron/dispatch?job=${job}`, opts.panelUrl).toString();
  const call = async (job: string, token?: string) => {
    const res = await doFetch(url(job), { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store', signal: AbortSignal.timeout(130_000) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const anon = await call('tenants');
  out.push(anon.status === 401 ? check('cron.auth', 'pass', 'Sin el secreto, el disparador responde 401') : check('cron.auth', 'fail', `Sin el secreto, el disparador respondió ${anon.status} (debía ser 401)`));

  const tenants = await call('tenants', opts.secret);
  const s = tenants.body as { due?: number; ran?: number; ok?: number; failed?: number; deferred?: number };
  const counts = `due=${s.due} ran=${s.ran} ok=${s.ok} failed=${s.failed} deferred=${s.deferred}`;
  if (tenants.status === 401) out.push(check('cron.tenants', 'fail', 'El secreto no vale en el panel desplegado', 'CRON_SECRET debe estar en las variables del panel (≥ 24 caracteres).'));
  else if (tenants.status === 200) out.push((s.due ?? 0) > 0 && (s.ran ?? 0) === 0 ? check('cron.tenants', 'fail', `Había tareas vencidas y no se lanzó ninguna (${counts})`) : check('cron.tenants', 'pass', `job=tenants respondió 200 (${counts})`, (s.ran ?? 0) === 0 ? 'No había nada vencido: ¿hay clientes dados de alta?' : undefined));
  else out.push(check('cron.tenants', 'fail', `job=tenants respondió ${tenants.status} (${counts})`, 'Vercel marcaría esa ejecución como fallida. Mira el log del panel: «[cron-dispatch] … falló para el cliente».'));

  const snaps = await call('snapshots-refresh', opts.secret);
  out.push(snaps.status === 200 ? check('cron.snapshots', 'pass', `job=snapshots-refresh republicó ${String((snaps.body as { published?: number }).published ?? '?')} registros`) : check('cron.snapshots', 'fail', `job=snapshots-refresh respondió ${snaps.status}`, JSON.stringify(snaps.body).slice(0, 200)));
  return out;
}
