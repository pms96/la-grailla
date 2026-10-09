import { NextResponse, type NextRequest } from 'next/server';
import { isCrossOriginMutation } from './lib/origin';

export function middleware(req: NextRequest) {
  // Una vista previa de Vercel (rama o PR) no es el panel: aunque heredase variables de producción, no sirve nada.
  if (process.env.VERCEL_ENV === 'preview') return new NextResponse('No disponible', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (isCrossOriginMutation(req.method, req.headers.get('origin'), req.headers.get('host'))) {
    return new NextResponse('Origen no permitido', { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
