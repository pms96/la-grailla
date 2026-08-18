import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@next-auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { rateLimit, getClientIpFromHeaderRecord } from '@/lib/rate-limit';

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
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
        const emailLimit = rateLimit('login-email', credentials.email.toLowerCase(), 5, 15 * 60_000);
        const ipLimit = rateLimit('login-ip', ip, 20, 15 * 60_000);
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
      }
      return token;
    },
    async session({ session, token }) {
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
  secret: process.env.NEXTAUTH_SECRET,
};
