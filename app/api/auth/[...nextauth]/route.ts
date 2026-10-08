import NextAuth from 'next-auth';
import { authOptions, getAuthOptions } from '@/lib/auth';
import { isPlatformMode } from '@/lib/tenant/mode';

// Modo normal: el handler de siempre. Modo plataforma: las opciones (secreto, cookies) dependen del cliente de la
// petición, así que el handler se crea por petición.
const legacyHandler = NextAuth(authOptions);

type RouteContext = { params: { nextauth: string[] } };

async function handler(req: Request, ctx: RouteContext) {
  if (!isPlatformMode()) return legacyHandler(req, ctx);
  return NextAuth(req as never, ctx as never, getAuthOptions());
}

export { handler as GET, handler as POST };
