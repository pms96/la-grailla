import { postlog } from '@/lib/postlog';
export const dynamic = 'force-dynamic';
export async function GET() { return Response.json({ postlog, boot: globalThis.__boot ?? null }); }
