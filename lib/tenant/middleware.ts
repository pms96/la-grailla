import { getToken } from 'next-auth/jwt';
import { sessionCookieName } from './session-cookie';
import { NextResponse, type NextRequest } from 'next/server';
import { deriveInstallationSecret, parseMasterKey } from '@grailla/contracts';
import { isCrossOriginMutation, isOriginCheckExempt } from '@/lib/origin-check';
import { isAuthorizedStaffRequest } from '@/lib/staff-paths';
import { signContext } from './context-sign';
import { CONTEXT_HEADER, type TenantContext } from './context-types';
import { isDevHost } from './dev-host';
import { legacyTenantId } from './mode';
import { resolveHost } from './resolve';

/* Middleware del modo plataforma (edge). Hace, por este orden, TODO lo que debe ocurrir antes de que un handler vea la petición:
 *   1. resolver el Host a un cliente (registro firmado) → 404 si no existe;
 *   2. cliente suspendido → 503 (salvo lo que nunca se corta: webhooks y crons);
 *   3. comprobación de Origin en peticiones que modifican datos;
 *   4. sesión de staff con el secreto DE ESE cliente en /admin, /acceso y las API de staff;
 *   5. pasar el contexto a los handlers en una cabecera firmada (borrando antes cualquier cabecera interna que mande el cliente). */

/** Rutas que no se cortan aunque el cliente esté suspendido: un webhook de pago o un cron que no llega es dinero perdido. */
export function isNeverBlockable(path: string): boolean {
  return path.startsWith('/api/webhooks/') || path.startsWith('/api/cron/');
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

export async function platformMiddleware(req: NextRequest): Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  // Solo el header `host`: x-forwarded-host y compañía los puede mandar el cliente.
  const rawHost = (req.headers.get('host') ?? '').toLowerCase();

  const resolved = await resolveHost(rawHost);
  if (resolved.status === 'not_found') return plain(404, 'Sitio no configurado');
  if (resolved.status === 'unavailable') return plain(503, 'Servicio no disponible temporalmente', { 'Retry-After': '5' });
  const ctx: TenantContext = { ...resolved.ctx, host: rawHost };

  if (ctx.status !== 'ACTIVE' && !isNeverBlockable(path)) return plain(503, 'Servicio suspendido');

  if (path.startsWith('/api/') && !isOriginCheckExempt(path) && isCrossOriginMutation(req.method, req.headers)) {
    return NextResponse.json({ error: 'Origen no permitido' }, { status: 403, headers: noStore });
  }

  const needsStaff = path.startsWith('/admin') || path.startsWith('/acceso') || path.startsWith('/api/');
  if (needsStaff) {
    const secret = await sessionSecretFor(ctx);
    if (!secret) return plain(503, 'Servicio no disponible temporalmente', { 'Retry-After': '5' });
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
  if (!key) return plain(503, 'Servicio no disponible temporalmente', { 'Retry-After': '5' });
  forwarded.set(CONTEXT_HEADER, await signContext(ctx, parseMasterKey(key)));

  const res = NextResponse.next({ request: { headers: forwarded } });
  if (isPublicPage(path, req.method)) {
    // Páginas públicas: la caché de Vercel incluye el Host en su clave, así que no se mezclan clientes. La etiqueta permite purgar solo a uno.
    res.headers.set('Vercel-Cache-Tag', `t:${ctx.tenantId}:public`);
  } else {
    res.headers.set('Cache-Control', 'private, no-store');
  }
  return res;
}
