/* Hook de instrumentación de Next (P0-07). INERTE sin `SENTRY_DSN`: no se carga el SDK de Sentry ni se inicializa nada, y el servidor se
 * comporta exactamente igual que sin este fichero. Solo runtime Node: el middleware (edge) y el navegador no tienen SDK.
 * Los imports son dinámicos y están DENTRO de `if (NEXT_RUNTIME === 'nodejs')`: así el compilador del edge descarta la rama (el SDK y
 * `node:crypto` no entran en el bundle del middleware) y, sin DSN, el SDK ni se evalúa. */

/** Un fallo del SDK (paquete no trazado en la función, Node demasiado antiguo…) se anota UNA vez y el servidor arranca sin Sentry: nunca tumba el sitio. */
let reportedFailure = false;
function noteFailure(where: string, err: unknown): void {
  if (reportedFailure) return;
  reportedFailure = true;
  console.error(`[sentry] ${where} falló (${err instanceof Error ? err.name : 'error'}): el servidor sigue sin captura de errores`);
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.SENTRY_DSN?.trim()) {
    try {
      const { initSentry } = await import('./lib/observability/sentry-server');
      initSentry();
    } catch (err) {
      noteFailure('la carga del SDK', err);
    }
  }
}

type RequestInfo = { path: string; method: string; headers: Record<string, string | string[] | undefined> };
type ErrorContext = { routerKind: string; routePath: string; routeType: string };

/** Next llama aquí con los errores que no ha capturado nuestro código (render de páginas, handlers sin try/catch). */
export async function onRequestError(error: unknown, request: RequestInfo, context: ErrorContext): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.SENTRY_DSN?.trim()) {
    try {
      const { reportRequestError } = await import('./lib/observability/sentry-server');
      reportRequestError(error, request, context);
    } catch (err) {
      // el aviso es accesorio: un fallo del SDK no cambia la respuesta
      noteFailure('el aviso de un error', err);
    }
  }
}
