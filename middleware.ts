import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

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

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const path = req.nextUrl?.pathname ?? '';
        if (path?.startsWith('/admin') || path?.startsWith('/acceso')) {
          return !!token;
        }
        return true;
      },
    },
  }
);

export const config = {
  matcher: ['/admin/:path*', '/acceso/:path*'],
};
