import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { rateLimit, getClientIpFromHeaderRecord } from '@/lib/rate-limit';
import { currentTenant, requireTenant } from '@/lib/tenant/context';
import { getInstallationSecret, isLegacyTenant } from '@/lib/tenant/installation-secret';
import { isDevHost } from '@/lib/tenant/dev-host';
import { isPlatformMode } from '@/lib/tenant/mode';

const baseOptions: NextAuthOptions = {
  // Sin adapter a propósito: la sesión es JWT y el único proveedor es
  // Credentials, así que el adapter nunca se ejecutaba. Quitarlo evita que
  // next-auth reciba un cliente Prisma fijo (el de una sola BD) cuando el
  // cliente pase a resolverse por tenant. Las tablas Account/Session/
  // VerificationToken del esquema quedan sin uso.
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Contraseña', type: 'password' },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;

        const ip = getClientIpFromHeaderRecord(req?.headers);
        const [emailLimit, ipLimit] = await Promise.all([
          rateLimit('login-email', credentials.email.toLowerCase(), 5, 15 * 60_000),
          rateLimit('login-ip', ip, 20, 15 * 60_000),
        ]);
        if (!emailLimit.ok || !ipLimit.ok) {
          throw new Error('too_many_attempts');
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });
        if (!user || !user?.hashedPassword) return null;
        const isValid = await bcrypt.compare(credentials.password, user.hashedPassword);
        if (!isValid) return null;
        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        // Defensa en profundidad: además de que el secreto es distinto por cliente, el token lleva su cliente.
        if (isPlatformMode()) token.tid = requireTenant().tenantId;
      }
      return token;
    },
    async session({ session, token }) {
      if (isPlatformMode() && !tokenBelongsToCurrentTenant(token.tid as string | undefined)) {
        // Sesión de otro cliente (o sin cliente): sin usuario, así cualquier comprobación de rol la rechaza.
        return { expires: session.expires } as typeof session;
      }
      if (session.user && token?.id) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
      }
      return session;
    },
    // No confiar en NEXTAUTH_URL para resolver callbackUrls relativos: si está mal
    // configurado para el entorno actual (p. ej. apunta a localhost en producción),
    // el comportamiento por defecto de next-auth redirige al host equivocado tras
    // signOut/signIn. Las rutas relativas se dejan tal cual; el navegador las
    // resuelve contra el origen actual.
    async redirect({ url, baseUrl }) {
      if (url.startsWith('/')) return url;
      try {
        if (new URL(url).origin === baseUrl) return url;
      } catch {
        // url inválida, caer al baseUrl por defecto
      }
      return baseUrl;
    },
  },
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/auth/login',
  },
};

/**
 * El `tid` del token debe ser el del cliente actual. El cliente legacy conserva sus sesiones anteriores a esta
 * versión, que no llevan `tid`; cualquier otro cliente EXIGE que coincida.
 */
function tokenBelongsToCurrentTenant(tid: string | undefined): boolean {
  const ctx = currentTenant();
  if (!ctx) return false;
  if (tid === undefined) return isLegacyTenant(ctx);
  return tid === ctx.tenantId;
}

/**
 * Opciones de NextAuth para la petición en curso.
 *  - Modo normal: las de siempre (secret = NEXTAUTH_SECRET).
 *  - Modo plataforma: secreto derivado DEL CLIENTE (la cookie de un cliente no abre otro) y `useSecureCookies` fijo:
 *    con la autodetección, el nombre de la cookie depende de x-forwarded-proto y una lectura sin esa cabecera no
 *    encontraría la sesión (medido en el spike M1).
 */
export function getAuthOptions(): NextAuthOptions {
  if (!isPlatformMode()) return { ...baseOptions, secret: process.env.NEXTAUTH_SECRET };
  const ctx = requireTenant();
  return { ...baseOptions, secret: getInstallationSecret('session'), useSecureCookies: !isDevHost(ctx.host) };
}

/**
 * `authOptions` se sigue importando como un objeto más en los ~87 `getServerSession(authOptions)`, pero cada lectura de
 * una propiedad se resuelve contra el cliente de la petición. `getServerSession` copia el objeto con Object.assign,
 * por eso están todas las trampas de enumeración.
 */
export const authOptions: NextAuthOptions = new Proxy(baseOptions, {
  get: (_t, prop) => (getAuthOptions() as unknown as Record<string | symbol, unknown>)[prop],
  has: (_t, prop) => prop in getAuthOptions(),
  ownKeys: () => Reflect.ownKeys(getAuthOptions()),
  getOwnPropertyDescriptor: (_t, prop) => {
    const options = getAuthOptions() as unknown as Record<string | symbol, unknown>;
    return prop in options ? { value: options[prop], enumerable: true, configurable: true, writable: true } : undefined;
  },
  // next-auth hace `options.secret ??= process.env.NEXTAUTH_SECRET`: la asignación se ignora, el secreto lo decide getAuthOptions().
  set: () => true,
});
