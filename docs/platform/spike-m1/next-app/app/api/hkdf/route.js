import { deriveSecret } from '@/lib/crypto';
export const dynamic = 'force-dynamic';
export async function GET(req) { return Response.json({ node: await deriveSecret(process.env.PLATFORM_MASTER, req.headers.get('x-tenant-id')) }); }
