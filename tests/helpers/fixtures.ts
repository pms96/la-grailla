import { prisma } from '@/lib/prisma';

let counter = 0;
// Identificador único y legible por ejecución de test, para no chocar con
// datos reales ni con otras ejecuciones en paralelo de la suite.
function uniqueSuffix() {
  counter += 1;
  return `test-${Date.now()}-${counter}`;
}

export async function createTestEvent(overrides: { maxCapacity?: number } = {}) {
  const suffix = uniqueSuffix();
  const event = await prisma.event.create({
    data: {
      name: `[TEST] Evento ${suffix}`,
      slug: `test-evento-${suffix}`,
      venue: 'Sala de pruebas',
      city: 'Testville',
      date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      maxCapacity: overrides.maxCapacity ?? 500,
      status: 'PUBLISHED',
    },
  });
  return event;
}

export async function createTicketType(eventId: string, overrides: { maxQuantity?: number; price?: number } = {}) {
  return prisma.ticketType.create({
    data: {
      eventId,
      name: `Entrada test ${uniqueSuffix()}`,
      price: overrides.price ?? 10,
      maxQuantity: overrides.maxQuantity ?? 100,
    },
  });
}

// Borra un evento de test y todo lo que cuelga de él, en el orden correcto
// para no chocar con las claves foráneas (Ticket -> Event es RESTRICT, no
// CASCADE, así que hay que vaciar tickets/orders antes de borrar el evento).
export async function cleanupTestEvent(eventId: string) {
  await prisma.ticket.deleteMany({ where: { eventId } });
  await prisma.order.deleteMany({ where: { eventId } });
  await prisma.event.delete({ where: { id: eventId } }).catch(() => {});
}

export async function getAndSetConfig(key: string, value: string): Promise<string | null> {
  const original = await prisma.appConfig.findUnique({ where: { key } });
  await prisma.appConfig.upsert({
    where: { key },
    update: { value },
    create: { key, value, label: key, group: 'test' },
  });
  return original?.value ?? null;
}

export async function restoreConfig(key: string, originalValue: string | null) {
  if (originalValue === null) {
    await prisma.appConfig.delete({ where: { key } }).catch(() => {});
  } else {
    await prisma.appConfig.update({ where: { key }, data: { value: originalValue } }).catch(() => {});
  }
}
