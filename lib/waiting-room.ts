import { prisma } from '@/lib/prisma';

// Expira admisiones caducadas y promueve a WAITING -> ADMITTED tantas
// entradas como huecos libres haya, todo dentro de un pg_advisory_xact_lock
// con scope propio (':queue', nunca el mismo que el lock de compra de
// app/api/orders/route.ts). Sin este lock, dos llamadas casi simultáneas
// podrían leer "quedan N huecos" antes de que ninguna confirme y admitir el
// doble de gente de la debida — el mismo tipo de condición de carrera que ya
// se evita para el stock, aplicado aquí a los huecos de la sala de espera.
// La sección crítica es un par de queries muy baratas, así que el lock se
// libera en milisegundos y no reintroduce el cuello de botella original.
export async function sweepAndAdmit(eventId: string, concurrentSlots: number, windowSeconds: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId} || ':queue'))`;

    await tx.$executeRaw`
      UPDATE "WaitingRoomEntry" SET status = 'EXPIRED'
      WHERE "eventId" = ${eventId} AND status = 'ADMITTED' AND "expiresAt" < now()`;

    const activeAdmitted = await tx.waitingRoomEntry.count({
      where: { eventId, status: 'ADMITTED', expiresAt: { gt: new Date() } },
    });
    const freeSlots = Math.max(0, concurrentSlots - activeAdmitted);
    if (freeSlots > 0) {
      await tx.$executeRaw`
        UPDATE "WaitingRoomEntry" SET status = 'ADMITTED', "admittedAt" = now(), "expiresAt" = now() + (${windowSeconds}::text || ' seconds')::interval
        WHERE id IN (
          SELECT id FROM "WaitingRoomEntry"
          WHERE "eventId" = ${eventId} AND status = 'WAITING'
          ORDER BY "joinedAt" ASC
          LIMIT ${freeSlots}
        )`;
    }
  });
}
