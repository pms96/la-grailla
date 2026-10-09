import { getToken } from 'next-auth/jwt';
import { sessionCookieName } from './session-cookie';
import { NextResponse, type NextRequest } from 'next/server';
import { deriveInstallationSecret, effectiveLicensePhase, enabledModules, isSchemaAtLeast, parseMasterKey, type LicensePhase } from '@grailla/contracts';
import { isLicenseExempt, ownerEnabled, ownerOfPath } from '@/lib/modules/registry';
import { isCrossOriginMutation, isOriginCheckExempt } from '@/lib/origin-check';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';
import { isAuthorizedStaffRequest, isStaffApiPath } from '@/lib/staff-paths';
import { signContext } from './context-sign';
import { CONTEXT_HEADER, type TenantContext } from './context-types';
import { isDevHost } from './dev-host';
import { checkPlatformEnvOnce } from './env-check';
import { logRateLimited } from './log';
import { legacyTenantId } from './mode';
import { resolveHost } from './resolve';

/* Middleware del modo plataforma (edge). Hace, por este orden, TODO lo que debe ocurrir antes de que un handler vea la petición:
 *   1. resolver el Host a un cliente (registro firmado) → 404 si no existe;
 *   2. cliente suspendido → 503 (salvo lo que nunca se corta: webhooks y crons);
 *   2a. puerta de esquema (M7): un cliente cuya BD está por detrás de lo que exige este build recibe «en mantenimiento» (503), solo él;
 *   2b. módulos y licencia (M5): una ruta sin dueño o de un módulo que el cliente no tiene → 404; fase PANEL_BLOCKED → sin /admin; fase
 *      BLOCKED → solo la allowlist (lib/modules/registry.ts) y el aviso;
 *   3. comprobación de Origin en peticiones que modifican datos;
 *   4. sesión de staff con el secreto DE ESE cliente en /admin, /acceso y las API de staff;
 *   5. pasar el contexto a los handlers en una cabecera firmada (borrando antes cualquier cabecera interna que mande el cliente). */

/** Rutas que no se cortan aunque el cliente esté suspendido: un webhook de pago o un cron que no llega es dinero perdido; la salud, para que el panel pueda ver el estado. */
export function isNeverBlockable(path: string): boolean {
  return path.startsWith('/api/webhooks/') || path.startsWith('/api/cron/') || path === '/api/health';
}

export type SchemaGate = { kind: 'api' | 'plain'; status: 503; message: string };

/**
 * Puerta de esquema (pura): ¿se puede servir esta ruta a un cliente cuya BD está en `schemaVersion`, con un front que exige `min`?
 * Devuelve null si se sirve. Un `schemaVersion` desconocido (null) cuenta como atrasado: ante la duda, no se sirve. `/api/health` se
 * sirve siempre: es lo que permite al panel ver QUÉ le falta a ese cliente.
 */
export function gateBySchema(path: string, schemaVersion: string | null | undefined, min: string = FRONT_MIN_SCHEMA): SchemaGate | null {
  if (path === '/api/health') return null;
  if (isSchemaAtLeast(schemaVersion, min)) return null;
  return { kind: path.startsWith('/api/') ? 'api' : 'plain', status: 503, message: 'Cliente en mantenimiento' };
}

/** Lo que es «el panel»: /admin, su API y las dos APIs de gestión de invitaciones (staff) que usa `/admin/invitaciones`. La taquilla y el escáner son venta/puerta y siguen. */
function isPanelPath(path: string): boolean {
  return (
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path.startsWith('/api/admin/') ||
    path === '/api/invitations' ||
    path.startsWith('/api/invitations/') ||
    path === '/api/guest-lists' ||
    path.startsWith('/api/guest-lists/')
  );
}

export type Gate =
  | { kind: 'not_found' }
  | { kind: 'api'; status: number; error: string }
  | { kind: 'notice'; status: number };

/**
 * Qué se corta por módulo y por licencia (null = pasa). Default-deny: una ruta sin dueño no existe. La allowlist (webhooks, crons,
 * validación de entradas vendidas, lo que ya compró un comprador, reembolsos) no se corta por fase ni por módulo.
 *   - PANEL_BLOCKED: sin /admin (ni su API); la web pública y las ventas siguen.
 *   - BLOCKED: nada, salvo la allowlist y el login.
 */
export function gateByModuleAndLicense(path: string, method: string, modules: readonly string[], phase: LicensePhase): Gate | null {
  if (isLicenseExempt(path, method)) return null;
  const owner = ownerOfPath(path);
  if (owner === null || !ownerEnabled(owner, enabledModules(modules))) return { kind: 'not_found' };
  // robots.txt y sitemap.xml no son páginas: un 503 sin cuerpo HTML (para un buscador, «no disponible por ahora»).
  const isApi = path.startsWith('/api/') || /\.(txt|xml)$/.test(path);
  if (phase === 'BLOCKED') return isApi ? { kind: 'api', status: 503, error: 'Servicio no disponible' } : { kind: 'notice', status: 503 };
  if (phase === 'PANEL_BLOCKED' && isPanelPath(path)) {
    return isApi ? { kind: 'api', status: 402, error: 'Licencia vencida' } : { kind: 'notice', status: 402 };
  }
  return null;
}

const noStore = { 'Cache-Control': 'no-store' };

function plain(status: number, message: string, extra: Record<string, string> = {}): NextResponse {
  return new NextResponse(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noStore, ...extra } });
}

let cachedMaster: { raw: string; value: Uint8Array } | null = null;
function sessionMaster(): Uint8Array | null {
  const raw = process.env.PLATFORM_SESSION_MASTER;
  if (!raw) return null;
  if (cachedMaster?.raw === raw) return cachedMaster.value;
  const value = parseMasterKey(raw);
  cachedMaster = { raw, value };
  return value;
}

/** El mismo secreto de sesión que calcula el runtime Node (hay un test de igualdad). */
async function sessionSecretFor(ctx: Pick<TenantContext, 'tenantId' | 'epoch'>): Promise<string | null> {
  if (legacyTenantId() === ctx.tenantId) return process.env.LEGACY_NEXTAUTH_SECRET ?? null;
  const master = sessionMaster();
  return master ? deriveInstallationSecret(master, ctx.tenantId, ctx.epoch, 'session') : null;
}

const isPublicPage = (path: string, method: string) =>
  (method === 'GET' || method === 'HEAD') && !path.startsWith('/api/') && !path.startsWith('/admin') && !path.startsWith('/acceso') && !path.startsWith('/auth');

/** Un despliegue de vista previa de Vercel (rama o PR) nunca sirve clientes: aunque heredase variables de producción, no resuelve ningún dominio. */
export const isPreviewDeployment = (): boolean => process.env.VERCEL_ENV === 'preview';

export async function platformMiddleware(req: NextRequest): Promise<NextResponse> {
  if (isPreviewDeployment()) return plain(404, 'Sitio no configurado');
  checkPlatformEnvOnce();
  const path = req.nextUrl.pathname;
  // Solo el header `host`: x-forwarded-host y compañía los puede mandar el cliente.
  const rawHost = (req.headers.get('host') ?? '').toLowerCase();

  const resolved = await resolveHost(rawHost);
  if (resolved.status === 'not_found') return plain(404, 'Sitio no configurado');
  if (resolved.status === 'unavailable') {
    // Sin esto, un registro caído o una firma que no verifica es un 503 sin una sola línea de log.
    logRateLimited(`unavailable:${rawHost}`, `[tenant-middleware] 503 en ${rawHost}: ${resolved.reason}`);
    return plain(503, 'Servicio no disponible temporalmente', { 'Retry-After': '5' });
  }
  const ctx: TenantContext = { ...resolved.ctx, host: rawHost };

  // Fase de licencia EFECTIVA ahora: avanza sola por el calendario del snapshot, pero solo con una lectura fresca (ver contrato).
  const now = Date.now();
  const phase = ctx.license ? effectiveLicensePhase(ctx.license, now, { fresh: !resolved.stale }) : 'ACTIVE';
  // Con calendario, el próximo cambio es el siguiente que NO ha pasado (null si ya han pasado todos); sin él, el del snapshot.
  ctx.license = { phase, nextPhaseChangeAt: ctx.license?.schedule ? (ctx.license.schedule.find((c) => c.at > now)?.at ?? null) : (ctx.license?.nextPhaseChangeAt ?? null) };

  if (ctx.status !== 'ACTIVE' && !isNeverBlockable(path)) return plain(503, 'Servicio suspendido');

  // BD del cliente por detrás de lo que exige este build: mantenimiento SOLO para él (los demás clientes siguen). Se reintenta pronto:
  // en cuanto el runner de migraciones publica la versión nueva en el registro, el cliente vuelve solo.
  const schemaGate = gateBySchema(path, ctx.schemaVersion);
  if (schemaGate) {
    const headers = { 'Retry-After': '30', ...noStore };
    return schemaGate.kind === 'api'
      ? NextResponse.json({ error: schemaGate.message }, { status: schemaGate.status, headers })
      : plain(schemaGate.status, schemaGate.message, { 'Retry-After': '30' });
  }

  const gate = gateByModuleAndLicense(path, req.method, ctx.modules, phase);
  if (gate?.kind === 'not_found') return path.startsWith('/api/') ? NextResponse.json({ error: 'No encontrado' }, { status: 404, headers: noStore }) : plain(404, 'No encontrado');
  // Sin la fase en el cuerpo: esta respuesta sale antes de autenticar y no debe contarle a un anónimo el estado de pago del cliente.
  if (gate?.kind === 'api') return NextResponse.json({ error: gate.error }, { status: gate.status, headers: noStore });

  if (path.startsWith('/api/') && !isOriginCheckExempt(path) && isCrossOriginMutation(req.method, req.headers)) {
    return NextResponse.json({ error: 'Origen no permitido' }, { status: 403, headers: noStore });
  }

  // Solo lo que es de staff necesita leer la sesión. El resto de la API (webhooks de pago, crons, salud, compras) no: así una clave de
  // sesión que falte no tumba además los webhooks, y un webhook de Stripe que no llega se reintenta hasta que Stripe desactiva el endpoint.
  const needsStaff = path.startsWith('/admin') || path.startsWith('/acceso') || isStaffApiPath(path);
  if (needsStaff) {
    const secret = await sessionSecretFor(ctx);
    if (!secret) {
      logRateLimited('no-session-secret', '[tenant-middleware] 503: falta PLATFORM_SESSION_MASTER (o LEGACY_NEXTAUTH_SECRET para el cliente legacy): no se puede leer ninguna sesión de staff');
      return plain(503, 'Servicio no disponible temporalmente', { 'Retry-After': '5' });
    }
    const token = await getToken({ req, secret, secureCookie: !isDevHost(ctx.host), cookieName: sessionCookieName(ctx) });
    // La sesión debe ser DE ESTE cliente. El legacy conserva sesiones anteriores a `tid`; el resto exige que coincida.
    const sameTenant = token ? (token.tid === undefined ? legacyTenantId() === ctx.tenantId : token.tid === ctx.tenantId) : false;
    const role = sameTenant ? (token?.role as string | undefined) : undefined;

    if (path.startsWith('/admin') && role !== 'ADMIN') return NextResponse.redirect(new URL('/auth/login', req.url));
    if (path.startsWith('/acceso') && role !== 'ADMIN' && role !== 'TAQUILLA') return NextResponse.redirect(new URL('/auth/login', req.url));
    if (!isAuthorizedStaffRequest(path, role)) return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers: noStore });
  }

  const forwarded = new Headers(req.headers);
  forwarded.delete(CONTEXT_HEADER); // nunca se confía en lo que traiga el cliente
  const key = process.env.PLATFORM_CONTEXT_KEY;
  if (!key) {
    logRateLimited('no-context-key', '[tenant-middleware] 503: falta PLATFORM_CONTEXT_KEY: no se puede firmar el contexto de ningún cliente');
    return plain(503, 'Servicio no disponible temporalmente', { 'Retry-After': '5' });
  }
  forwarded.set(CONTEXT_HEADER, await signContext(ctx, parseMasterKey(key)));

  if (gate?.kind === 'notice') {
    // El aviso es una página del propio front, con el contexto del cliente (necesita su dominio y su fase).
    const url = req.nextUrl.clone();
    url.pathname = '/licencia';
    url.search = '';
    return NextResponse.rewrite(url, { request: { headers: forwarded }, status: gate.status, headers: noStore });
  }

  const res = NextResponse.next({ request: { headers: forwarded } });
  if (isPublicPage(path, req.method)) {
    // Páginas públicas: la caché de Vercel incluye el Host en su clave, así que no se mezclan clientes. La etiqueta permite purgar solo a uno.
    res.headers.set('Vercel-Cache-Tag', `t:${ctx.tenantId}:public`);
  } else {
    res.headers.set('Cache-Control', 'private, no-store');
  }
  return res;
}
