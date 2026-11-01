import { describe, it, expect, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { readShopMarkers, shopCandidates, shopMarkersQuery } from '@/lib/email-delivery';

/* H-047: las consultas de entrega de emails de la tienda recorrían TODA la historia de `ProcessedWebhookEvent` (una tabla que no se purga) con `LIKE 'email:shop:%'`,
 * dos veces por reclamo y en cada listado del admin y sondeo de salud. Ahora se leen por la clave primaria (igualdad) o acotadas por fecha (índice `processedAt`).
 * Se comprueba el PLAN de ejecución con los recorridos secuenciales desactivados: si alguna consulta no puede usar un índice, el plan lo delata con un «Seq Scan». */

const ids = [`h047-${Date.now()}-a`, `h047-${Date.now()}-b`];

async function planOf(query: Prisma.Sql): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    const rows = await tx.$queryRaw<{ 'QUERY PLAN': unknown }[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`);
    return JSON.stringify(rows[0]['QUERY PLAN']);
  });
}
const seqScansOnMarkers = (plan: string) => (plan.match(/"Node Type":"Seq Scan"[^}]*"Relation Name":"ProcessedWebhookEvent"/g) ?? []).length;

describe('consultas de entrega de emails de la tienda (H-047)', () => {
  afterAll(async () => {
    await prisma.processedWebhookEvent.deleteMany({ where: { id: { in: ids.flatMap((i) => [`email:shop:${i}`, `email:shop:${i}:due`, `email:shop:${i}:try:1`]) } } });
  });

  it('el plan de los candidatos del barrido no recorre toda la tabla de marcadores', async () => {
    const plan = await planOf(Prisma.sql`SELECT * FROM (${shopCandidates(new Date(Date.now() - 24 * 3_600_000))}) c`);
    expect(seqScansOnMarkers(plan), plan).toBe(0);
  });

  it('el plan de la lectura de marcadores de unos pedidos usa la clave primaria', async () => {
    const plan = await planOf(shopMarkersQuery(ids));
    expect(seqScansOnMarkers(plan), plan).toBe(0);
  });

  it('readShopMarkers sigue dando los mismos marcadores (enviado, pendiente, intentos)', async () => {
    const [a] = ids;
    const t = new Date('2026-01-02T10:00:00Z');
    await prisma.processedWebhookEvent.createMany({
      data: [
        { id: `email:shop:${a}:due`, processedAt: new Date('2026-01-02T09:00:00Z') },
        { id: `email:shop:${a}:try:1`, processedAt: t },
        { id: `email:shop:${a}`, processedAt: new Date('2026-01-02T10:05:00Z') },
      ],
      skipDuplicates: true,
    });
    const m = (await readShopMarkers([a, ids[1]])).get(a)!;
    expect(m.sentAt?.toISOString()).toBe('2026-01-02T10:05:00.000Z');
    expect(m.dueAt?.toISOString()).toBe('2026-01-02T09:00:00.000Z');
    expect(m.tries).toBe(1);
    expect(m.lastTryAt?.toISOString()).toBe(t.toISOString());
    const other = (await readShopMarkers([ids[1]])).get(ids[1])!;
    expect(other).toMatchObject({ sentAt: null, dueAt: null, leaseAt: null, tries: 0 });
  });

  it('un pedido distinto cuyo id es prefijo de otro no hereda sus marcadores', async () => {
    const [a] = ids;
    await prisma.processedWebhookEvent.createMany({ data: [{ id: `email:shop:${a}x:due` }], skipDuplicates: true });
    try {
      expect((await readShopMarkers([a])).get(a)!.tries).toBe(1); // el try:1 de arriba, no los de `${a}x`
      expect((await readShopMarkers([a])).get(a)!.dueAt?.toISOString()).toBe('2026-01-02T09:00:00.000Z');
    } finally {
      await prisma.processedWebhookEvent.deleteMany({ where: { id: `email:shop:${a}x:due` } });
    }
  });
});
