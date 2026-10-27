import * as Sentry from '@sentry/nextjs';
import { CONTEXT_HEADER } from '@/lib/tenant/context-types';
import { platformContextKey, verifyContext } from '@/lib/tenant/context-verify';
import { isPlatformMode } from '@/lib/tenant/mode';
import { safeTenantId } from './capture';
import { scrubBreadcrumb, scrubEvent } from './scrub';

/* Sentry SOLO en el servidor (runtime Node). Este módulo importa el SDK: SOLO se carga con `import()` dinámico desde instrumentation.ts y
 * capture.ts, y solo si hay `SENTRY_DSN`. Sin `withSentryConfig` (no sube source maps ni toca el build) y sin SDK de navegador.
 *
 * Configuración deliberadamente mínima, para que el SDK no cambie el comportamiento del servidor:
 *  - integraciones: solo filtro de eventos, cadena de causas y deduplicado. Nada de consola/HTTP/fetch (breadcrumbs con URLs y argumentos),
 *    ni manejadores globales de excepciones (podrían terminar el proceso), ni lectura de ficheros para pintar código, ni variables locales;
 *  - nada de datos de personas: `dataCollection` lo apaga todo (la versión 11 del SDK recoge por defecto usuario, cookies, cabeceras y cuerpos);
 *  - sin OpenTelemetry (`enableOpenTelemetrySetup: false`: no toca el fetch de Next ni registra un proveedor de trazas) ni inyección de
 *    módulos en tiempo de carga; `tracesSampleRate: 0`: solo errores;
 *  - todo evento y breadcrumb pasa por scrub.ts; si el filtro falla, el evento se descarta. */

/** Id del cliente de la petición: del contexto actual o, si no lo hay (onRequestError puede llamarse fuera de él), de la cabecera firmada. */
export function tenantFromRequestHeaders(headers: Record<string, string | string[] | undefined> | undefined): string | null {
  try {
    const raw = headers?.[CONTEXT_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const key = platformContextKey();
    if (!value || !key) return null;
    return verifyContext(value, key, Date.now())?.tenantId ?? null;
  } catch {
    return null;
  }
}

const deployment = (): 'platform' | 'single' => (isPlatformMode() ? 'platform' : 'single');

export function beforeSend<E extends Sentry.ErrorEvent>(event: E): E | null {
  try {
    return scrubEvent(event, { tenantId: safeTenantId(), deployment: deployment() });
  } catch {
    return null; // ante la duda, no se envía
  }
}

export function beforeBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  try {
    return scrubBreadcrumb(crumb);
  } catch {
    return null;
  }
}

/** Opciones de `Sentry.init`, o null si no hay DSN (en ese caso no se inicializa nada). */
export function buildSentryOptions(env: NodeJS.ProcessEnv = process.env): Sentry.NodeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.VERCEL_ENV || env.NODE_ENV || 'development',
    release: env.VERCEL_GIT_COMMIT_SHA || undefined,
    // v11 retiró `sendDefaultPii` y sus valores por defecto recogen TODO (usuario, cookies, cabeceras, cuerpos, query, variables locales): se apaga cada
    // categoría a mano. El filtro de scrub.ts sigue siendo la segunda barrera.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    tracesSampleRate: 0,
    maxBreadcrumbs: 5,
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    sendClientReports: false,
    shutdownTimeout: 2_000,
    defaultIntegrations: false,
    integrations: [Sentry.eventFiltersIntegration(), Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    beforeSend,
    beforeBreadcrumb,
  };
}

/** Inicializa el SDK. Devuelve false (y no hace nada) sin DSN. Nunca lanza: un fallo del SDK no puede impedir que arranque el servidor. */
export function initSentry(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Sentry.NodeOptions> = {}): boolean {
  try {
    const options = buildSentryOptions(env);
    if (!options) return false;
    Sentry.init({ ...options, ...overrides }); // `overrides` solo lo usan los tests (transporte simulado)
    return true;
  } catch (err) {
    console.error(`[sentry] no se pudo inicializar (${err instanceof Error ? err.name : 'error'}): la captura de errores queda desactivada`);
    return false;
  }
}

/* Tope por instancia: si la BD cae, CADA petición da un 500 y sin límite cada una sería un evento (cuota de Sentry y ruido). Sentry ya agrupa y
 * aplica su protección contra picos; esto acota además el origen. 20 por minuto y por instancia (cada instancia de Vercel tiene su propia cuenta). */
export const CAPTURE_WINDOW_MS = 60_000;
export const CAPTURE_MAX_PER_WINDOW = 20;
let recent: number[] = [];
export function allowCapture(now: number = Date.now()): boolean {
  recent = recent.filter((t) => now - t < CAPTURE_WINDOW_MS);
  if (recent.length >= CAPTURE_MAX_PER_WINDOW) return false;
  recent.push(now);
  return true;
}
/** Solo tests. */
export function resetCaptureLimitForTests(): void {
  recent = [];
}

/** Envío en segundo plano y acotado (2 s): en Vercel se cuelga de `waitUntil` para que la respuesta no espere. */
function flushInBackground(): void {
  const task = Sentry.flush(2_000).catch(() => false);
  try {
    const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[Symbol.for('@vercel/request-context')];
    ctx?.get?.()?.waitUntil?.(task);
  } catch {
    // fuera de Vercel no hay waitUntil: el envío sigue en segundo plano
  }
}

/** Captura explícita con el contexto mínimo (etiquetas de lista cerrada). Sin cliente inicializado no hace nada. */
export function captureOps(error: unknown, tags: Record<string, string>, tenant: string | null): void {
  try {
    if (!Sentry.getClient() || !allowCapture()) return;
    Sentry.captureException(error, { tags: { ...tags, ...(tenant ? { tenant } : {}) } });
    flushInBackground();
  } catch {
    // nunca rompe la respuesta
  }
}

type RequestInfo = { path: string; method: string; headers: Record<string, string | string[] | undefined> };
type ErrorContext = { routerKind: string; routePath: string; routeType: string };

/** Errores que Next ve sin que nuestro código los capture (render, handlers sin try/catch): `onRequestError` de instrumentation.ts. */
export function reportRequestError(error: unknown, request: RequestInfo, context: ErrorContext): void {
  try {
    if (!Sentry.getClient() || !allowCapture()) return;
    const tenant = safeTenantId() ?? tenantFromRequestHeaders(request.headers);
    Sentry.withScope((scope) => {
      if (tenant) scope.setTag('tenant', tenant);
      Sentry.captureRequestError(error, request, context);
    });
  } catch {
    // nunca rompe la respuesta
  }
}
