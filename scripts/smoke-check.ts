/* Smoke post-despliegue (P1-22 · OB-14/OB-15): tras cada despliegue, ¿responde de verdad la web de cada cliente?
 *
 *   npx tsx scripts/smoke-check.ts https://www.lagrailla.es https://otro-cliente.es
 *   SMOKE_URLS="https://a.es,https://b.es" npx tsx scripts/smoke-check.ts
 *
 * Por cliente comprueba, SOLO con lecturas públicas (no crea pedidos ni toca datos):
 *   1. `/` responde 200 con HTML;
 *   2. `/api/health` responde 200 y `{"status":"ok"}` (BD viva y el front sirviendo a ese cliente: en mantenimiento da 503);
 *   3. `/eventos` responde 200 y, si hay un evento publicado, su ficha y su página de compra también (la que se cae primero en un lanzamiento).
 *      Un cliente sin el módulo de entradas (`/eventos` da 404 y su home no lo enlaza) no es un fallo; un cliente sin eventos publicados tampoco.
 *      SÍ es un fallo que `/eventos` dé 404 estando enlazado desde la home (la ruta ha desaparecido) o que responda 200 con el aviso de que no
 *      pudo cargar los eventos (la página captura el error de BD y devuelve 200: sin esta comprobación, un fallo de BD pasaría en verde).
 * Sale con código 1 si algo falla (el workflow marca el despliegue en rojo) y con 2 si no hay ninguna URL que comprobar. */
import path from 'node:path';

export type SmokeCheck = { name: string; url: string; ok: boolean; status: number | null; ms: number; detail: string | null };
export type SmokeReport = { target: string; checks: SmokeCheck[]; ok: boolean };
type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<{ status: number; text(): Promise<string> }>;

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 3_000;
const SLOW_MS = 8_000;
// La página de eventos captura el error de la consulta y responde 200 con un aviso; el texto varía según la plantilla.
const EVENTS_LOAD_ERROR = /No hemos podido cargar (la programaci[oó]n|la agenda|la cartelera|los eventos)/i;
// El menú público solo enlaza /eventos si el módulo de entradas está activo (se filtra con las mismas reglas que el servidor).
const LINKS_TO_EVENTS = /href="\/eventos["/?#]/i;

/** URLs del entorno o de los argumentos → orígenes `https://host` sin duplicados. Lanza si alguna no es una URL http(s) válida. */
export function parseTargets(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[\s,]+/).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(piece) ? piece : `https://${piece}`);
    } catch {
      throw new Error(`URL no válida: «${piece}»`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Solo http(s): «${piece}»`);
    if (!out.includes(url.origin)) out.push(url.origin);
  }
  return out;
}

/** Quita lo que no debe llegar a una línea de log: saltos y caracteres de control (con ellos, un cuerpo remoto podría abrir una orden `::` nueva). */
export function oneLine(text: string, max = 300): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}

/** Slug del primer evento enlazado en el HTML del listado, o null. */
export function discoverEventSlug(html: string): string | null {
  const match = /href="\/eventos\/([a-z0-9][a-z0-9-]*)"/i.exec(html);
  return match ? match[1] : null;
}

type Deps = { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; now?: () => number };

async function get(url: string, deps: Required<Deps>): Promise<{ status: number | null; body: string; ms: number; error: string | null }> {
  const started = deps.now();
  let last: { status: number | null; body: string; error: string | null } = { status: null, body: '', error: 'sin respuesta' };
  // Un arranque en frío o un 5xx suelto no deben tumbar un despliegue sano: una repetición tras una pausa corta.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await deps.sleep(RETRY_DELAY_MS);
    try {
      const res = await deps.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'follow' });
      last = { status: res.status, body: (await res.text()).slice(0, 500_000), error: null };
      if (res.status < 500) break;
    } catch (err) {
      last = { status: null, body: '', error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
    }
  }
  return { ...last, ms: deps.now() - started };
}

export async function smokeTarget(origin: string, deps: Deps = {}): Promise<SmokeReport> {
  const d: Required<Deps> = {
    fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init)),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  };
  const checks: SmokeCheck[] = [];
  const add = (name: string, url: string, res: { status: number | null; ms: number; error: string | null }, ok: boolean, why: string, note: string | null = null) => {
    const slow = res.ms > SLOW_MS ? `lento: ${Math.round(res.ms / 1000)} s` : null;
    const detail = ok ? [note, slow].filter(Boolean).join(' · ') || null : [res.error ?? why, slow].filter(Boolean).join(' · ');
    checks.push({ name, url, ok, status: res.status, ms: res.ms, detail });
  };

  const home = await get(`${origin}/`, d);
  add('home', `${origin}/`, home, home.status === 200 && /<html/i.test(home.body), `HTTP ${home.status}, se esperaba 200 con HTML`);

  const health = await get(`${origin}/api/health`, d);
  let healthStatus: string | null = null;
  try {
    const raw = (JSON.parse(health.body) as { status?: unknown }).status;
    healthStatus = typeof raw === 'string' ? oneLine(raw, 40) : null; // viene del cliente: va a un mensaje, así que se sanea
  } catch {
    /* no era JSON */
  }
  add('health', `${origin}/api/health`, health, health.status === 200 && healthStatus === 'ok', `HTTP ${health.status}, estado «${healthStatus ?? 'sin estado'}» (se esperaba 200 y «ok»)`);

  const events = await get(`${origin}/eventos`, d);
  if (events.status === 404 && !LINKS_TO_EVENTS.test(home.body)) {
    add('eventos', `${origin}/eventos`, events, true, '', 'sin módulo de entradas (omitido)');
  } else {
    const loadFailed = events.status === 200 && EVENTS_LOAD_ERROR.test(events.body);
    const slug = events.status === 200 && !loadFailed ? discoverEventSlug(events.body) : null;
    const note = events.status === 200 && !loadFailed && !slug ? 'sin eventos publicados (ficha y compra omitidas)' : null;
    const why = loadFailed
      ? 'la página responde 200 pero avisa de que no pudo cargar los eventos (¿BD caída?)'
      : events.status === 404
        ? 'HTTP 404, pero la home enlaza /eventos: la ruta ha desaparecido'
        : `HTTP ${events.status}, se esperaba 200`;
    add('eventos', `${origin}/eventos`, events, events.status === 200 && !loadFailed, why, note);
    if (slug) {
      for (const [name, suffix] of [['evento', ''], ['comprar', '/comprar']] as const) {
        const url = `${origin}/eventos/${slug}${suffix}`;
        const res = await get(url, d);
        add(name, url, res, res.status === 200, `HTTP ${res.status}, se esperaba 200`);
      }
    }
  }
  return { target: origin, checks, ok: checks.every((c) => c.ok) };
}

export async function smokeAll(targets: string[], deps: Deps = {}): Promise<SmokeReport[]> {
  return Promise.all(targets.map((t) => smokeTarget(t, deps)));
}

/** Líneas legibles del informe; los fallos salen como anotaciones de GitHub (`::error::`) para verse en el resumen del despliegue. */
export function formatReport(reports: SmokeReport[]): string[] {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`${r.ok ? '✓' : '✗'} ${r.target}`);
    for (const c of r.checks) {
      lines.push(`    ${c.ok ? '✓' : '✗'} ${c.name.padEnd(8)} ${String(c.status ?? '—').padEnd(4)} ${String(c.ms).padStart(5)} ms${c.detail ? `  ${c.detail}` : ''}`);
      if (!c.ok) lines.push(`::error title=Smoke ${oneLine(r.target)}::${c.name} ${oneLine(c.url)} → ${oneLine(c.detail ?? 'falla')}`);
    }
  }
  return lines;
}

async function main(argv: string[]): Promise<number> {
  const raw = [...argv, process.env.SMOKE_URLS ?? ''].join(' ');
  const targets = parseTargets(raw);
  if (targets.length === 0) {
    console.error('Sin URLs que comprobar: pásalas como argumentos o en SMOKE_URLS (separadas por comas).');
    return 2;
  }
  const reports = await smokeAll(targets);
  for (const line of formatReport(reports)) console.log(line);
  return reports.every((r) => r.ok) ? 0 : 1;
}

// Uso: npx tsx scripts/smoke-check.ts <url> [<url> …]
if (process.argv[1] && path.basename(process.argv[1]) === 'smoke-check.ts') {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    }
  );
}
