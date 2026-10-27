/* Depuración de lo que sale hacia Sentry (P0-07). Funciones PURAS y sin dependencias (ni del SDK ni de Next): lo que se prueba aquí es lo que
 * garantiza que ningún dato personal salga del servidor, así que no puede depender de cómo se inicialice el SDK.
 *
 * Política (docs/platform/observabilidad.md): del servidor solo salen el tipo y el mensaje del error (redactado), la pila (solo rutas y nombres de
 * función, sin código ni variables), la ruta (patrón, no la URL real) y unas pocas etiquetas de una lista cerrada (`tenant` = id del cliente,
 * nunca su Host ni el nombre del negocio). Se ELIMINAN la petición entera (cabeceras, cookies, cuerpo, query string, URL), el usuario y los datos
 * adjuntos de los «breadcrumbs». Lo que queda de texto libre se redacta: emails, teléfonos, tokens, claves de pasarela, ids de pago, URLs de BD.
 * Es un filtro de último recurso: la primera barrera es no pasarle nunca datos del comprador (ver capture.ts). */

const MAX_TEXT = 1000;
const MAX_DEPTH = 5;
const REDACTED = '[filtrado]';

/** Los 8 primeros caracteres de un id de pedido: suficiente para localizarlo en la BD, insuficiente para reconstruirlo. */
export function truncateId(id: unknown, length = 8): string {
  return typeof id === 'string' ? id.slice(0, length) : '';
}

/** TLD habituales: un dominio o Host de cliente en un mensaje (`ENOTFOUND www.cliente.es`) no debe salir. Se excluyen a propósito los que coinciden con extensiones de fichero (`.js`, `.ts`, `.json`, `.map`). */
const TLDS = 'es|com|net|org|eu|io|app|dev|cat|info|biz|xyz|cloud|online|site|shop|store|club|tech|live|events';
/** Proveedores de BD gestionada: su host identifica al cliente (el endpoint de Neon es por proyecto). */
const DB_HOSTS = '(?:neon\\.tech|supabase\\.(?:co|com)|rds\\.amazonaws\\.com|planetscale\\.(?:com|app)|upstash\\.io|railway\\.app|cockroachlabs\\.cloud)';

const rules: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // URLs de conexión (BD, Redis…): llevan usuario y contraseña. Antes que cualquier otra regla.
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s'"<>)]+/gi, '[url-bd]'],
  // Cabeceras de cookies enteras (también fuera de una petición: aparecen en mensajes de error de librerías HTTP).
  [/\b(?:Set-)?Cookie:[^\n]*/gi, 'Cookie: [filtrado]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic [token]'],
  // Claves de pasarela y secretos de webhook: sk_live_…, rk_test_…, pk_…, whsec_…
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, '[clave]'],
  [/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]{8,}/g, '[clave]'],
  // Ids de pago/sesión de las pasarelas (Stripe: cs_test_…, pi_…, ch_…, evt_…, cus_…). Largos: no se confunde con `in_progress` y similares.
  [/\b(?:cs|pi|ch|evt|pm|cus|seti|tok|py|re|sub|in)_(?:live_|test_)?[A-Za-z0-9]{14,}\b/g, '[id-pago]'],
  [/\b(?:cs)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[id-pago]'],
  // Credenciales incrustadas en una URL (`https://usuario:clave@host`): antes que los emails, que las confundirían con `clave@host`.
  [/\/\/[^\s/@'"]+@/g, '//[cred]@'],
  // Emails (también codificados en una URL: `juan%40correo.es`).
  [/[A-Za-z0-9._'-]{1,64}(?:@|%40)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/gi, '[email]'],
  // URLs: fuera query string y fragmento (llevan `t=`, tokens de acceso, firmas…), también en rutas relativas (`/api/admin/orders?q=…`).
  [/(https?:\/\/[^\s?#'"<>)]*)[?#][^\s'"<>)]*/gi, '$1'],
  [/(?<=\/[A-Za-z0-9_\-.~%/]{0,300})\?[^\s'"<>)]*/g, ''],
  // Parámetros sueltos fuera de una URL: `t=…`, `token=…`, `signature=…`.
  [/\b(t|token|access_token|id_token|refresh_token|key|apikey|api_key|secret|signature|sig|code|password|pwd)=([^\s&"',;)]+)/gi, '$1=[token]'],
  // Ids de pedido/pago completos (UUID, cuid): se dejan truncados a 8 caracteres, como en las etiquetas.
  [/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1…'],
  [/\bc[a-z0-9]{24}\b/g, (m) => `${m.slice(0, 8)}…`],
  // Datos bancarios y de identidad: IBAN, DNI/NIE.
  [/\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/g, '[iban]'],
  [/\b(?:\d{8}|[XYZxyz]\d{7})[- ]?[A-Za-z]\b/g, '[dni]'],
  // Direcciones IP: v4 y v6 (una v6 sin letras ni `::`, como una hora 12:30:45, no se toca).
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi, (m) => (m.includes('::') || /[a-f]/i.test(m) ? '[ip]' : m)],
  // Hosts: endpoints de BD gestionada (con o sin puerto), cualquier `host:puerto` y dominios con TLD habitual.
  [new RegExp(`\\b[A-Za-z0-9][A-Za-z0-9.-]{0,100}\\.${DB_HOSTS}(?::\\d{2,5})?\\b`, 'gi'), '[host-bd]'],
  [/\b[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63}){1,8}:\d{2,5}\b/g, (m) => (/\.(?:[cm]?[jt]sx?|json|map|css|html?|py|rb)\:/i.test(m) ? m : '[host]')], // `route.js:12` (fichero:línea) no es un host
  [new RegExp(`\\b(?:[A-Za-z0-9-]{1,63}\\.){1,8}(?:${TLDS})\\b`, 'gi'), '[dominio]'],
  // Teléfonos: internacional (+34 600 11 22 33, 0034…), con prefijo entre paréntesis y nacionales de 9 cifras (móviles 6/7, fijos 8/9).
  [/(?:\+|\b00)\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}/g, '[telefono]'],
  [/\(\d{2,3}\)[\s.-]?\d{2,4}(?:[\s.-]\d{2,4}){1,3}/g, '[telefono]'],
  // Números de tarjeta (13-19 cifras, con espacios o guiones).
  [/\b\d(?:[ -]?\d){12,18}\b/g, '[numero]'],
  [/\b[6-9]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/g, '[telefono]'],
  [/\b[6-9]\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}\b/g, '[telefono]'],
  // Cualquier otra cifra suelta de 9 a 11 dígitos (un teléfono con prefijo sin `+`: 34600112233). Sobre-redacta, a propósito.
  [/(?<![\w.])\d{9,11}(?![\w])/g, '[telefono]'],
];

/** Cadenas largas y opacas con letras y cifras (tokens, firmas): se tapan. Una palabra larga sin cifras (un nombre de función) se respeta. */
const OPAQUE = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Una llamada de Prisma con cualquier nombre: `prisma.order.create()`, `tx.order.update()`, `p.order.create()`, `prisma.$queryRaw()`, `this.prisma.x.y()`. */
const PRISMA_INVOCATION = /`([A-Za-z_$][\w$.]*\(\))`\s+invocation/;
/** Clases de error de Prisma: aunque su mensaje no traiga «invocation», solo se conserva su primera línea. */
export const PRISMA_ERROR_CLASS = /^PrismaClient(?:KnownRequest|Validation|UnknownRequest|Initialization|RustPanic)Error$/;

/**
 * Los errores de Prisma llevan la consulta con sus VALORES (nombres, emails, teléfonos del comprador) y los de SQL en crudo, el valor enlazado.
 * Se conserva SOLO la operación y la última línea del error (que es el motivo: «Argument `x` is missing», «Record to update not found»), y de esa
 * línea se quita lo que pueda llevar un valor: texto entre comillas y lo que sigue a «provided/got», y el `Message: …` de una consulta en crudo
 * (de ella solo se queda el código SQLSTATE). Si el mensaje cabe en una sola línea no hay «última línea» de la que fiarse: solo la operación.
 */
export function collapsePrismaMessage(message: string): string | null {
  const m = PRISMA_INVOCATION.exec(message);
  if (!m) return null;
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const code = /\bCode:\s*`([A-Za-z0-9]+)`/.exec(message)?.[1];
  let tail = '';
  if (lines.length > 1 && !PRISMA_INVOCATION.test(last)) {
    if (/^Raw query failed/i.test(last) || /Message:\s*`/.test(last)) tail = `Raw query failed${code ? ` (código ${code})` : ''}`;
    else tail = last.replace(/"[^"]*"/g, '"[v]"').replace(/\b(provided|got|received)\b.*$/i, '$1 [v]').slice(0, 300);
  }
  return `Prisma ${m[1]}${tail ? `: ${tail}` : ''}`;
}

/** Redacta un texto libre. Nunca lanza; recorta a un máximo para que ni un volcado de objeto se cuele entero. */
export function scrubString(input: string, max = MAX_TEXT): string {
  // Los caracteres de ANCHO COMPLETO (`＠`, `．`, cifras) pasan a su forma normal antes de buscar emails y teléfonos. Solo ese bloque: NFKC general
  // cambiaría también `…` (la marca de truncado) y el filtro dejaría de ser idempotente.
  let s = (input.length > max * 4 ? input.slice(0, max * 4) : input).replace(/[\uFF01-\uFF5E]/g, (c) => c.normalize('NFKC'));
  s = collapsePrismaMessage(s) ?? s;
  for (const [re, to] of rules) s = s.replace(re, to as string);
  s = s.replace(OPAQUE, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '[token]' : m));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Claves cuyo valor no sale nunca (y la clave tampoco), sea cual sea su contenido: campos de personas, credenciales y datos de la petición. */
const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|cookies|headers?|body|query|querystring|query_string|data|payload|pass|tel|ip|ip_address|host|hostname|domain|url|referer|origin|user|username|session|card)$|name|surname|apellid|nombre|email|mail|phone|telefono|address|direccion|dni|nif|iban|zip|postal|password|passwd|pwd|secret|token|cookie|signature|apikey|api_key/i;

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (SENSITIVE_KEY.test(k)) continue; // se descarta la clave entera: un campo con nombre de persona no debe ni aparecer
      out[k] = scrubValue(v, depth + 1);
    }
    return out;
  }
  return REDACTED; // funciones, símbolos, bigint…
}

/** Lista cerrada de etiquetas que pueden salir. Lo demás (host, url, server_name, nombre del negocio…) se descarta aunque algo lo añada. */
const ALLOWED_TAGS = new Set(['tenant', 'deployment', 'route', 'provider', 'kind', 'reason', 'order', 'handled', 'mechanism', 'runtime', 'transaction']);
/** Id de cliente: un ULID o el id interno del cliente de La Grailla. Cualquier otra cosa (un Host, un nombre) no es un id y no sale como `tenant`. */
const TENANT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const looksLikeHost = (v: string) => /\./.test(v) || /\s/.test(v);

/** Contextos que pueden salir y, de cada uno, los únicos campos que salen: el resto describe la máquina o la petición. */
const CONTEXT_FIELDS: Record<string, string[]> = {
  runtime: ['name', 'version'],
  trace: ['trace_id', 'span_id', 'parent_span_id', 'op', 'status'],
  nextjs: ['router_kind', 'router_path', 'route_type'], // `request_path` (la ruta concreta) no: puede llevar ids o tokens
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Ruta de un fichero de la pila sin directorios de la máquina: lo que cuelga de `.next/`, `node_modules/` o `/var/task/`, o si no, los tres últimos tramos. Idempotente. */
function relativePath(file: string): string {
  const path = file.replace(/^file:\/\//, '').replace(/[?#].*$/, '');
  const marker = /(?:^|\/)(\.next\/|node_modules\/)/.exec(path);
  if (marker) return path.slice(marker.index + marker[0].length - marker[1].length);
  const task = path.indexOf('/var/task/');
  if (task >= 0) return path.slice(task + '/var/task/'.length);
  return path.split('/').slice(-3).join('/');
}

function scrubFrame(frame: Obj): Obj {
  const filename = typeof frame.filename === 'string' ? frame.filename : typeof frame.abs_path === 'string' ? frame.abs_path : undefined;
  return {
    ...(filename ? { filename: scrubString(relativePath(filename), 300) } : {}),
    ...(typeof frame.function === 'string' ? { function: scrubString(frame.function, 200) } : {}),
    ...(typeof frame.module === 'string' ? { module: scrubString(frame.module, 200) } : {}),
    ...(typeof frame.lineno === 'number' ? { lineno: frame.lineno } : {}),
    ...(typeof frame.colno === 'number' ? { colno: frame.colno } : {}),
    ...(typeof frame.in_app === 'boolean' ? { in_app: frame.in_app } : {}),
    // Sin `vars`, `pre_context`, `context_line` ni `post_context`: son código y valores de variables.
  };
}

/**
 * Depura un evento de Sentry antes de enviarlo. Pura y a prueba de formas raras: ante cualquier fallo el llamante descarta el evento
 * (es preferible perder un aviso a filtrar un dato personal). `tenantId` = id del cliente al que pertenece la petición, si se conoce.
 */
export function scrubEvent<T extends object>(event: T, opts: { tenantId?: string | null; deployment?: 'platform' | 'single' } = {}): T {
  const e = event as Obj;

  // Fuera todo lo que describe a la persona, a la petición o a la máquina.
  delete e.request;
  delete e.user;
  delete e.server_name;
  delete e.modules;
  delete e.sdkProcessingMetadata; // lleva la petición normalizada (cabeceras incluidas) hasta el momento de enviar
  delete e.attachments;
  // Con esta configuración llegan vacíos, pero llevarían pilas sin depurar (`threads`), rutas de la máquina (`debug_meta`) o SQL (`spans`).
  delete e.threads;
  delete e.debug_meta;
  delete e.spans;
  if (Array.isArray(e.fingerprint)) e.fingerprint = e.fingerprint.map((f) => (typeof f === 'string' ? scrubString(f, 100) : f));

  if (typeof e.message === 'string') e.message = scrubString(e.message);
  if (isObj(e.logentry)) {
    if (typeof e.logentry.message === 'string') e.logentry.message = scrubString(e.logentry.message);
    delete e.logentry.params;
  }
  if (typeof e.transaction === 'string') e.transaction = scrubString(e.transaction, 200);

  const exc = isObj(e.exception) ? e.exception : null;
  if (exc && Array.isArray(exc.values)) {
    for (const v of exc.values) {
      if (!isObj(v)) continue;
      if (typeof v.value === 'string') {
        // Un error de Prisma sin «invocation» en el mensaje (p. ej. de inicialización) conserva solo su primera línea; el resto lleva consultas y valores.
        const firstLine = typeof v.type === 'string' && PRISMA_ERROR_CLASS.test(v.type) && !PRISMA_INVOCATION.test(v.value) ? (v.value.split('\n').find((l) => l.trim()) ?? '') : v.value;
        v.value = scrubString(firstLine);
      }
      if (typeof v.type === 'string') v.type = scrubString(v.type, 200);
      if (isObj(v.stacktrace) && Array.isArray(v.stacktrace.frames)) v.stacktrace.frames = v.stacktrace.frames.filter(isObj).map(scrubFrame);
      if (isObj(v.mechanism)) delete v.mechanism.data;
    }
  }

  // Datos adjuntos: lo que el código añadió a mano, con las claves sensibles tapadas y el resto redactado.
  if (isObj(e.extra)) e.extra = scrubValue(e.extra, 0);

  if (isObj(e.contexts)) {
    const kept: Obj = {};
    for (const [name, ctx] of Object.entries(e.contexts)) {
      const fields = CONTEXT_FIELDS[name];
      if (!fields || !isObj(ctx)) continue;
      const c: Obj = {};
      for (const f of fields) {
        const v = ctx[f];
        // Los ids de traza son hexadecimales opacos y no llevan datos: se dejan tal cual (el filtro de cadenas opacas los taparía).
        if (/_id$/.test(f) && typeof v === 'string' && /^[0-9a-f]{16,32}$/.test(v)) c[f] = v;
        else if (typeof v === 'string') c[f] = scrubString(v, 200);
        else if (typeof v === 'number') c[f] = v;
      }
      kept[name] = c;
    }
    e.contexts = kept;
  }

  // Etiquetas: solo la lista cerrada. `tenant` solo si parece un id y no un dominio o un nombre.
  const tags: Obj = {};
  if (isObj(e.tags)) {
    for (const [k, v] of Object.entries(e.tags)) {
      if (!ALLOWED_TAGS.has(k) || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) continue;
      tags[k] = typeof v === 'string' ? scrubString(v, 200) : v;
    }
  }
  if (opts.tenantId) tags.tenant = opts.tenantId;
  if (typeof tags.tenant === 'string' && (!TENANT_ID.test(tags.tenant) || looksLikeHost(tags.tenant))) delete tags.tenant;
  if (opts.deployment) tags.deployment = opts.deployment;
  e.tags = tags;

  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = e.breadcrumbs.map((b) => scrubBreadcrumb(b as Obj)).filter((b): b is Obj => b !== null);
  }
  return event;
}

/** Un breadcrumb solo conserva categoría, nivel y un mensaje corto redactado; `data` (URLs, cuerpos, argumentos) se elimina. */
export function scrubBreadcrumb<T extends object>(crumb: T): T | null {
  if (!isObj(crumb)) return null;
  const out: Obj = {};
  for (const k of ['type', 'category', 'level', 'timestamp'] as const) if (crumb[k] !== undefined) out[k] = crumb[k];
  if (typeof crumb.message === 'string') out.message = scrubString(crumb.message, 200);
  return out as T;
}
