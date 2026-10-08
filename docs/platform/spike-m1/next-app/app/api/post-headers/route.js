import { prisma, currentTenantId } from '@/lib/tenant';
import { postlog } from '@/lib/postlog';
export const dynamic = 'force-dynamic';
export async function GET() {
  const tid = currentTenantId();
  setTimeout(async () => {
    try { const r = await prisma.appConfig.findFirst({ where: { key: 'site_name' } }); postlog.push(`HDR ${tid} -> ${r.value}`); }
    catch (e) { postlog.push(`HDR ${tid} ERROR ${e.message}`); }
  }, 150);
  return Response.json({ scheduled: tid });
}
