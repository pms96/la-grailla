import { prisma } from '@/lib/prisma';

// No hay cron ni proceso de fondo que limpie WaitingRoomEntry — igual que la
// propia admisión, la limpieza va montada en el tráfico normal de
// join/status. Exportada por separado (en vez de en línea en el 2% de abajo)
// para poder probarla directamente sin depender de Math.random().
export async function cleanupStaleEntries(eventId: string): Promise<void> {
  await prisma.waitingRoomEntry.deleteMany({
    where: {
      eventId,
      status: { in: ['COMPLETED', 'EXPIRED'] },
      joinedAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) },
    },
  });
}

// Versión sin scope de evento para el cron (app/api/cron/cleanup-waiting-room):
// la limpieza de arriba solo se dispara con tráfico sobre ESE evento
// concreto, así que un evento ya pasado (sin nadie más entrando a su cola)
// nunca la activa y sus filas EXPIRED/COMPLETED se quedan para siempre.
export async function cleanupAllStaleEntries(): Promise<number> {
  const result = await prisma.waitingRoomEntry.deleteMany({
    where: {
      status: { in: ['COMPLETED', 'EXPIRED'] },
      joinedAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) },
    },
  });
  return result.count;
}

// Con una probabilidad baja en vez de en cada llamada: no hace falta que
// TODA petición pague el coste de este DELETE, solo que ocurra de vez en
// cuando para que la tabla no crezca sin límite con filas COMPLETED o
// EXPIRED de eventos que ya pasaron.
function opportunisticCleanup(eventId: string) {
  if (Math.random() >= 0.02) return;
  cleanupStaleEntries(eventId).catch(() => {});
}

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
  opportunisticCleanup(eventId);

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
