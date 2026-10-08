import { withTenant, currentTenantId, prisma, siteName, als } from '@/lib/tenant';
import { headers } from 'next/headers';
export const dynamic = 'force-dynamic';
export const GET = withTenant(async () => {
  const viaAls = als.getStore()?.tenantId;
  const viaHeaders = headers().get('x-tenant-id');
  const direct = await siteName();
  const tx = await prisma.$transaction(async (t) => {
    await new Promise((r) => setTimeout(r, Math.random() * 30));
    const stillAls = als.getStore()?.tenantId;
    const row = await t.appConfig.findFirst({ where: { key: 'site_name' } });
    await new Promise((r) => setTimeout(r, Math.random() * 30));
    return { stillAls, row: row?.value };
  });
  return Response.json({ viaAls, viaHeaders, direct, tx, after: currentTenantId() });
});
