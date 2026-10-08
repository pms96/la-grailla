import { withTenant, prisma, currentTenantId } from '@/lib/tenant';
import { postlog } from '@/lib/postlog';
export const dynamic = 'force-dynamic';
export const GET = withTenant(async () => {
  const tid = currentTenantId();
  setTimeout(async () => { // trabajo tras la respuesta (como after()/waitUntil)
    try { const r = await prisma.appConfig.findFirst({ where: { key: 'site_name' } }); postlog.push(`ALS ${tid} -> ${r.value}`); }
    catch (e) { postlog.push(`ALS ${tid} ERROR ${e.message}`); }
  }, 150);
  return Response.json({ scheduled: tid });
});
