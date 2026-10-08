import CredentialsProvider from 'next-auth/providers/credentials';
import { deriveSecret } from './crypto';
export async function optionsFor(tid) {
  return {
    secret: await deriveSecret(process.env.PLATFORM_MASTER, tid),
    session: { strategy: 'jwt' },
    ...(process.env.FORCE_SECURE ? { useSecureCookies: process.env.FORCE_SECURE === '1' } : {}),
    providers: [CredentialsProvider({ credentials: { password: { type: 'password' } },
      authorize: async (c) => (c?.password === 'ok' ? { id: 'u1', email: `admin@${tid}`, role: 'ADMIN' } : null) })],
    callbacks: {
      jwt: ({ token, user }) => { if (user) { token.role = user.role; token.tid = tid; } return token; },
      session: ({ session, token }) => { session.user.role = token.role; session.user.tid = token.tid; return session; },
    },
  };
}
