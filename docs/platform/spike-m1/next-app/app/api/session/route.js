import { getServerSession } from 'next-auth';
import { headers } from 'next/headers';
import { optionsFor } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export async function GET() {
  const tid = headers().get('x-tenant-id');
  const s = await getServerSession(await optionsFor(tid));
  return Response.json({ tid, session: s?.user ?? null, cookieNames: headers().get('cookie')?.split(';').map((c) => c.split('=')[0].trim()) });
}
