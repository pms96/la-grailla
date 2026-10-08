import { AsyncLocalStorage } from 'node:async_hooks';
import { headers } from 'next/headers';
import { isPlatformMode, legacyTenantId } from './mode';
import { platformContextKey, verifyContext } from './context-verify';
import { CONTEXT_HEADER, type TenantContext } from './context-types';

/* Contexto del cliente (tenant) al que pertenece la petición en curso. SOLO runtime Node.
 *
 * Lo fija el middleware (edge) tras resolver el Host contra el registro firmado, y viaja hasta aquí en una
 * cabecera interna con HMAC (ver context-sign.ts). Se lee de dos sitios, por este orden:
 *   1. el AsyncLocalStorage propio (runWithTenant): jobs, trabajo tras la respuesta y tests;
 *   2. la cabecera de la petición actual (`headers()` de Next): lo único que funciona en Server Components,
 *      `generateMetadata` y Suspense, que no se pueden envolver en un ALS propio (medido en el spike M1).
 * Sin contexto, en modo plataforma, TODO lo que necesite un cliente falla (fail-closed): nunca se cae a una
 * BD "por defecto". */

export type { TenantContext } from './context-types';
export { CONTEXT_HEADER } from './context-types';

export class TenantContextError extends Error {
  constructor(message = 'No hay un cliente (tenant) asociado a esta petición') {
    super(message);
    this.name = 'TenantContextError';
  }
}

const als = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return als.run(ctx, fn);
}

function fromRequestHeader(): TenantContext | null {
  let raw: string | null;
  try {
    raw = headers().get(CONTEXT_HEADER);
  } catch (err) {
    // Una página estática que lee `headers()` lanza DynamicServerError para que Next la haga dinámica: no es "sin cliente".
    if ((err as { digest?: unknown } | null)?.digest === 'DYNAMIC_SERVER_USAGE') throw err;
    return null; // fuera del ámbito de una petición
  }
  if (!raw) return null;
  const key = platformContextKey();
  return key ? verifyContext(raw, key, Date.now()) : null;
}

export function currentTenant(): TenantContext | null {
  return als.getStore() ?? fromRequestHeader();
}

/** El cliente actual o, si no hay ninguno, un error. Nunca devuelve un valor por defecto. */
export function requireTenant(): TenantContext {
  const ctx = currentTenant();
  if (!ctx) throw new TenantContextError();
  return ctx;
}

/** ¿Hay que aplicar el aislamiento por cliente? (modo plataforma) */
export const tenantIsolationOn = isPlatformMode;

/**
 * ¿Esta petición es de La Grailla? Instalación única: siempre. Modo plataforma: solo el cliente `legacy`. Decide de dónde salen los valores
 * por defecto de marca (los de La Grailla o los neutros): un cliente nuevo nunca hereda la identidad, el correo ni los textos de otro.
 */
export function isLegacyTenant(): boolean {
  if (!isPlatformMode()) return true;
  const legacy = legacyTenantId();
  const ctx = currentTenant();
  return !!legacy && !!ctx && ctx.tenantId === legacy;
}
