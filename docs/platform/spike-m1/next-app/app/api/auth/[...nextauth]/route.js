import NextAuth from 'next-auth';
import { optionsFor } from '@/lib/auth';
async function handler(req, ctx) { return NextAuth(req, ctx, await optionsFor(req.headers.get('x-tenant-id'))); }
export { handler as GET, handler as POST };
