import { NextResponse, type NextRequest } from 'next/server';
import { isCrossOriginMutation } from './lib/origin';

export function middleware(req: NextRequest) {
  if (isCrossOriginMutation(req.method, req.headers.get('origin'), req.headers.get('host'))) {
    return new NextResponse('Origen no permitido', { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
