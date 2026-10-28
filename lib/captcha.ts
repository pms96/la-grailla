import { NextResponse } from 'next/server';
import { getConfigsOrFail } from '@/lib/config';
import { safeTenantId } from '@/lib/observability/capture';
import { getClientIp } from '@/lib/rate-limit';
import { captureOpsError } from '@/lib/observability/capture';

/* Captcha (Cloudflare Turnstile) en los puntos de la web pública que reservan aforo o stock sin pagar: el pedido de entradas, el pedido de la
 * tienda y la entrada a la sala de espera (P1: EN-06 / TI-14). Es el complemento de los topes por IP y por pedidos pendientes, que un script con
 * muchas IP (o IPv6) esquiva.
 *
 *  - OPCIONAL y POR CLIENTE: cada cliente pone SUS claves (Configuración → General). Sin las dos claves, todo funciona como antes: no se carga ningún
 *    script de Cloudflare ni se hace ninguna llamada.
 *  - Falla ABIERTO ante problemas NUESTROS o de Cloudflare (no se alcanza `siteverify`, error interno, secreto mal puesto): un captcha caído no puede
 *    cerrar la venta de un cliente. Se deja constancia y se avisa a Sentry (como mucho una vez cada 10 min por instancia).
 *  - Falla CERRADO ante un token ausente, caducado, repetido o inválido: eso es justo lo que se quiere frenar.
 *  - Cada token vale para UNA acción (`order`, `shop-order`, `queue`): uno sacado en la sala de espera no sirve para pedir entradas. */

export type CaptchaAction = 'order' | 'shop-order' | 'queue';

export const CAPTCHA_SITE_KEY = 'turnstile_site_key';
export const CAPTCHA_SECRET_KEY = 'turnstile_secret_key';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 4_000;
/** Cloudflare documenta tokens de hasta 2048 caracteres: más largo no puede ser válido y ni se envía. */
const MAX_TOKEN_LENGTH = 2048;
const REPORT_EVERY_MS = 10 * 60_000;

export type CaptchaResult =
  | { ok: true; skipped: 'disabled' | 'unavailable' | null }
  | { ok: false; code: 'captcha_required' | 'captcha_failed' };

const SECRET_ERRORS = new Set(['missing-input-secret', 'invalid-input-secret']);
const TRANSIENT_ERRORS = new Set(['internal-error']);
/** Rechazos del TOKEN: mandan sobre cualquier otro código que viniera a la vez (un token malo nunca pasa por un fallo de servicio). */
const TOKEN_REJECTIONS = new Set(['invalid-input-response', 'timeout-or-duplicate', 'missing-input-response', 'bad-request']);

// Límite de avisos POR CLIENTE: el problema de uno no silencia el de otro en la misma instancia.
const lastReportAt = new Map<string, number>();
function reportUnavailable(reason: string, action: CaptchaAction): void {
  console.error(`[captcha] ${reason}: la petición pasa sin captcha (acción ${action})`);
  const now = Date.now();
  const scope = safeTenantId() ?? '-';
  if (now - (lastReportAt.get(scope) ?? 0) < REPORT_EVERY_MS) return;
  lastReportAt.set(scope, now);
  captureOpsError(new Error(`captcha_unavailable: ${reason}`), { route: `captcha ${action}`, provider: 'turnstile', reason: 'captcha_unavailable' });
}

/** Solo para las pruebas: reinicia el límite de avisos. */
export function resetCaptchaReportThrottle(): void {
  lastReportAt.clear();
}

/** Las dos claves del cliente, o null si el captcha no está activado (falta alguna). La clave secreta no sale nunca de aquí hacia el navegador. */
async function captchaKeys(): Promise<{ siteKey: string; secret: string; incomplete: boolean } | null> {
  // `OrFail`: un error de BD al leer la configuración LANZA (no se confunde con «captcha sin configurar»); lo trata quien llama.
  const cfg = await getConfigsOrFail([CAPTCHA_SITE_KEY, CAPTCHA_SECRET_KEY]);
  const siteKey = (cfg[CAPTCHA_SITE_KEY] ?? '').trim();
  const secret = (cfg[CAPTCHA_SECRET_KEY] ?? '').trim();
  if (siteKey && secret) return { siteKey, secret, incomplete: false };
  // Clave del sitio SIN secreta: o está a medias, o la secreta cifrada no se pudo descifrar. En los dos casos el captcha no actúa; se avisa.
  return siteKey ? { siteKey, secret: '', incomplete: true } : null;
}

/** Clave PÚBLICA para pintar el widget en la web del cliente, o '' si el captcha no está activado. */
export async function getCaptchaSiteKey(): Promise<string> {
  try {
    const keys = await captchaKeys();
    return keys && !keys.incomplete ? keys.siteKey : '';
  } catch {
    return '';
  }
}

type SiteverifyResponse = { success?: boolean; 'error-codes'?: unknown; action?: unknown };

/**
 * Comprueba el token del captcha de la petición. Con el captcha desactivado devuelve `ok` sin hacer nada. Nunca lanza.
 * `token` es lo que mandó el navegador (campo `captchaToken` del cuerpo).
 */
export async function verifyCaptcha(request: Request, token: unknown, action: CaptchaAction): Promise<CaptchaResult> {
  let keys: { siteKey: string; secret: string; incomplete: boolean } | null;
  try {
    keys = await captchaKeys();
  } catch {
    reportUnavailable('no se pudo leer la configuración', action);
    return { ok: true, skipped: 'unavailable' };
  }
  if (!keys) return { ok: true, skipped: 'disabled' };
  if (keys.incomplete) {
    reportUnavailable('falta la clave secreta (o no se pudo descifrar)', action);
    return { ok: true, skipped: 'disabled' };
  }

  if (typeof token !== 'string' || token.trim() === '') return { ok: false, code: 'captcha_required' };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, code: 'captcha_failed' };

  const ip = getClientIp(request);
  let data: SiteverifyResponse;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: keys.secret, response: token, ...(ip !== 'unknown' ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) {
      reportUnavailable(`siteverify respondió ${res.status}`, action);
      return { ok: true, skipped: 'unavailable' };
    }
    data = (await res.json()) as SiteverifyResponse;
  } catch (error) {
    reportUnavailable(`siteverify no responde (${error instanceof Error ? error.name : 'error'})`, action);
    return { ok: true, skipped: 'unavailable' };
  }

  if (data.success === true) {
    // El token se pidió en el widget de OTRA acción (p. ej. el de la cola usado para pedir entradas): no vale.
    if (typeof data.action === 'string' && data.action !== action) return { ok: false, code: 'captcha_failed' };
    return { ok: true, skipped: null };
  }

  const codes = Array.isArray(data['error-codes']) ? data['error-codes'].filter((c): c is string => typeof c === 'string') : [];
  // Un rechazo del token manda sobre cualquier otro código que venga a la vez.
  if (codes.some((c) => TOKEN_REJECTIONS.has(c))) return { ok: false, code: 'captcha_failed' };
  // El secreto del cliente mal puesto o un fallo interno de Cloudflare no son culpa del comprador: no se le cierra la venta.
  if (codes.some((c) => SECRET_ERRORS.has(c))) {
    reportUnavailable('la clave secreta no es válida', action);
    return { ok: true, skipped: 'unavailable' };
  }
  if (codes.some((c) => TRANSIENT_ERRORS.has(c))) {
    reportUnavailable('error interno de Cloudflare', action);
    return { ok: true, skipped: 'unavailable' };
  }
  return { ok: false, code: 'captcha_failed' };
}

/** Respuesta 400 para un captcha ausente o rechazado. `code` deja al navegador distinguir «hay que resolverlo» de «caducó, vuelve a intentarlo». */
export function captchaRejection(result: Extract<CaptchaResult, { ok: false }>): NextResponse {
  const error =
    result.code === 'captcha_required'
      ? 'Completa la comprobación de seguridad para continuar. Si no aparece, recarga la página.'
      : 'No hemos podido validar la comprobación de seguridad. Inténtalo de nuevo.';
  return NextResponse.json({ error, code: result.code }, { status: 400 });
}
