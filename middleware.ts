import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

const STAFF_ROLES = ['ADMIN', 'TAQUILLA'];

// Red de seguridad para las API de staff: cada route handler ya comprueba su
// propia sesión/rol (algunas admiten TAQUILLA además de ADMIN, p.ej.
// /api/admin/scans), así que aquí solo se exige "alguna sesión de staff" en
// vez de replicar el rol exacto de cada endpoint — esto no sustituye esos
// checks inline, solo evita que un endpoint nuevo que se olvide de
// comprobar la sesión quede abierto por defecto.
export function isStaffApiPath(path: string): boolean {
  return (
    path.startsWith('/api/admin') ||
    path.startsWith('/api/taquilla') ||
    path.startsWith('/api/scan') ||
    path.startsWith('/api/access')
  );
}

// Extraída como función pura (sin depender de withAuth/next-auth) para
// poder testear la decisión de autorización sin tener que fabricar un JWT
// firmado de verdad.
export function isAuthorizedStaffRequest(path: string, role: string | undefined | null): boolean {
  if (!isStaffApiPath(path)) return true;
  return STAFF_ROLES.includes(role ?? '');
}

export default withAuth(
  function middleware(req) {
    const token = req.nextauth?.token;
    const path = req.nextUrl?.pathname ?? '';

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

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const path = req.nextUrl?.pathname ?? '';
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

export const config = {
  matcher: [
    '/admin/:path*',
    '/acceso/:path*',
    '/api/admin/:path*',
    '/api/taquilla/:path*',
    '/api/scan',
    '/api/access/:path*',
  ],
};
