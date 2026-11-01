import { prisma } from '@/lib/prisma';
import { journalForget, journalNote, journalOriginal, type ConfigRow } from './config-journal';

let counter = 0;
// Identificador único y legible por ejecución de test, para no chocar con
// datos reales ni con otras ejecuciones en paralelo de la suite.
function uniqueSuffix() {
  counter += 1;
  return `test-${Date.now()}-${counter}`;
}

export async function createTestEvent(overrides: { maxCapacity?: number; date?: Date; status?: 'DRAFT' | 'PUBLISHED' | 'FINISHED' | 'CANCELLED'; onlineSalesClosed?: boolean } = {}) {
  const suffix = uniqueSuffix();
  const event = await prisma.event.create({
    data: {
      name: `[TEST] Evento ${suffix}`,
      slug: `test-evento-${suffix}`,
      venue: 'Sala de pruebas',
      city: 'Testville',
      date: overrides.date ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      maxCapacity: overrides.maxCapacity ?? 500,
      status: overrides.status ?? 'PUBLISHED',
      onlineSalesClosed: overrides.onlineSalesClosed ?? false,
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
  // H-151: solo «ya no existe» (P2025) se da por bueno; cualquier otro fallo (una clave foránea que impide borrar) debe verse, no dejar el evento de prueba huérfano en silencio.
  await prisma.event.delete({ where: { id: eventId } }).catch((error: { code?: string }) => {
    if (error?.code !== 'P2025') throw error;
  });
}

// H-151: lo primero que se hace con una clave de configuración es APUNTAR cómo estaba (diario fuera del repo); si la ejecución muere a medias, `globalSetup` la devuelve a
// su sitio en la siguiente. Ver tests/helpers/config-journal.ts.
const rowOf = (r: { key: string; value: string; label: string | null; group: string | null } | null): ConfigRow | null =>
  r ? { key: r.key, value: r.value, label: r.label, group: r.group } : null;

export async function getAndSetConfig(key: string, value: string): Promise<string | null> {
  const original = await prisma.appConfig.findUnique({ where: { key } });
  journalNote(key, rowOf(original));
  await prisma.appConfig.upsert({
    where: { key },
    update: { value },
    create: { key, value, label: key, group: 'test' },
  });
  return original?.value ?? null;
}

export async function restoreConfig(key: string, originalValue: string | null) {
  // Sin `.catch(() => {})`: una restauración que falla tiene que verse. Si la clave ya no existe, se vuelve a crear con su valor original.
  if (originalValue === null) {
    await prisma.appConfig.deleteMany({ where: { key } });
  } else {
    await prisma.appConfig.upsert({ where: { key }, update: { value: originalValue }, create: { key, value: originalValue, label: key, group: 'test' } });
  }
  // Se tacha del diario solo si lo restaurado ES el original apuntado (con anidamiento, la restauración intermedia no debe tachar la del test exterior).
  const noted = journalOriginal(key);
  if (noted !== undefined && (noted?.value ?? null) === originalValue) journalForget(key);
}

/** Guarda las filas de estas claves (apuntándolas en el diario) y las deja BORRADAS: el test parte de «nada configurado» sin perder lo real. Pareja de `restoreConfigSnapshot`. */
export async function snapshotConfig(keys: string[]): Promise<ConfigRow[]> {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: keys } }, select: { key: true, value: true, label: true, group: true } });
  for (const key of keys) journalNote(key, rowOf(rows.find((r) => r.key === key) ?? null));
  await prisma.appConfig.deleteMany({ where: { key: { in: keys } } });
  return rows;
}

/** Devuelve las claves a como estaban antes de `snapshotConfig` (borra lo que el test dejó y recrea lo guardado) y las tacha del diario. */
export async function restoreConfigSnapshot(keys: string[], saved: ConfigRow[]) {
  await prisma.appConfig.deleteMany({ where: { key: { in: keys } } });
  for (const row of saved) await prisma.appConfig.create({ data: row });
  for (const key of keys) journalForget(key);
}
