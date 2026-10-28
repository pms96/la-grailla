import { withAuth, type NextRequestWithAuth } from 'next-auth/middleware';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { isCrossOriginMutation, isOriginCheckExempt } from '@/lib/origin-check';
import { decodedPath, isAuthorizedStaffRequest } from '@/lib/staff-paths';
import { pathAllowedForModules } from '@/lib/modules/access';
import { isPlatformMode } from '@/lib/tenant/mode';
import { platformMiddleware } from '@/lib/tenant/middleware';

export { isStaffApiPath, isAuthorizedStaffRequest } from '@/lib/staff-paths';

// Modo normal (una sola instalación): exactamente el middleware de siempre.
const legacyMiddleware = withAuth(
  function middleware(req) {
    const token = req.nextauth?.token;
    const path = decodedPath(req.nextUrl?.pathname ?? '');

    // CSRF: una petición que modifica datos y que el navegador marca como
    // originada en otro sitio no llega a ningún handler (ver lib/origin-check.ts).
    if (path.startsWith('/api/') && !isOriginCheckExempt(path) && isCrossOriginMutation(req.method, req.headers)) {
      return NextResponse.json({ error: 'Origen no permitido' }, { status: 403 });
    }

    // Admin routes
    if (path?.startsWith('/admin') && token?.role !== 'ADMIN') {
      return NextResponse.redirect(new URL('/auth/login', req.url));
    }

    // Taquilla / Access routes
    if (path?.startsWith('/acceso') && token?.role !== 'ADMIN' && token?.role !== 'TAQUILLA') {
      return NextResponse.redirect(new URL('/auth/login', req.url));
    }

    // API de staff: un redirect no tiene sentido para un cliente que espera
    // JSON, así que aquí se responde 401 directamente en vez de reusar el
    // callback `authorized` (que por defecto redirige a la pantalla de login).
    if (!isAuthorizedStaffRequest(path, token?.role)) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    // Permisos por módulo (roles restringidos): ver lib/modules/access.ts. Sin `mods` en el token es el propietario.
    if (token?.role === 'ADMIN' && !pathAllowedForModules(path, Array.isArray(token.mods) ? (token.mods as string[]) : null)) {
      return path.startsWith('/api/')
        ? NextResponse.json({ error: 'Sin permiso para este módulo' }, { status: 403 })
        : NextResponse.redirect(new URL('/admin', req.url));
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const path = decodedPath(req.nextUrl?.pathname ?? '');
        if (path?.startsWith('/admin') || path?.startsWith('/acceso')) {
          return !!token;
        }
        // Las API de staff se gestionan dentro de middleware() para poder
        // devolver 401 JSON en vez del redirect por defecto de next-auth.
        return true;
      },
    },
  }
);

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  if (isPlatformMode()) return platformMiddleware(req);
  // Modo normal: las páginas públicas no pasan por next-auth (como antes, cuando el matcher no las incluía).
  const path = decodedPath(req.nextUrl.pathname);
  if (!path.startsWith('/admin') && !path.startsWith('/acceso') && !path.startsWith('/api/')) return NextResponse.next();
  return legacyMiddleware(req as NextRequestWithAuth, event);
}

export const config = {
  // En modo plataforma TODA ruta con datos de cliente tiene que resolver su cliente; en modo normal el middleware deja pasar
  // enseguida todo lo que no sea /admin, /acceso o /api (ver arriba). Solo se excluyen los estáticos de `public/` (carpeta
  // brand/ y ficheros de imagen o worker en la raíz): no llevan datos de cliente y así no cuestan una invocación del edge.
  // /api, /admin y /acceso siempre entran, aunque su ruta acabe en una extensión de imagen.
  matcher: [
    '/api/:path*',
    '/admin/:path*',
    '/acceso/:path*',
    '/((?!api/|admin/|acceso/|_next/static|_next/image|brand/|favicon\\.ico$|[^/]+\\.(?:png|jpg|jpeg|webp|svg|mjs)$).*)',
  ],
};
