import { prisma } from '@/lib/prisma';
import { currentTenant } from '@/lib/tenant/context';

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
//
// Con miles de personas sondeando, hacer ESTA transacción (cerrojo + 3 consultas) en cada sondeo era el grueso del coste (P1-12). Los sondeos de
// estado pasan `minIntervalMs`: si esta instancia ya barrió este evento hace menos de eso, se salta. Es seguro porque barrer es idempotente y
// quien lo salta solo retrasa la admisión como mucho `minIntervalMs` (otra instancia, o su siguiente sondeo, barre). `join` NO lo pasa: entrar
// en la cola con huecos libres debe admitir al momento.
const lastSweepAt = new Map<string, number>();
const MAX_THROTTLE_ENTRIES = 2000;

// El mapa es del proceso, y en modo plataforma un mismo proceso sirve a varios clientes: la clave lleva el cliente, para que el barrido de uno
// (aunque dos BDs repitieran un eventId, p. ej. una restaurada desde otra) nunca deje sin barrer a otro.
const throttleKey = (eventId: string) => `${currentTenant()?.tenantId ?? 'single'}:${eventId}`;
let sweepClock: () => number = () => Date.now();

/** Solo para tests: olvida cuándo se barrió cada evento y, si se pasa, sustituye el reloj del límite (sin argumento, vuelve al real). */
export function resetSweepThrottle(clock?: () => number): void {
  lastSweepAt.clear();
  sweepClock = clock ?? (() => Date.now());
}

/**
 * Cuánto debe esperar un cliente antes del siguiente sondeo, según su posición, con ±20 % de dispersión para que no lleguen todos a la vez.
 * Lo decide el servidor (el cliente solo obedece, acotado) para poder retocarlo sin esperar a que todos recarguen la página.
 */
export function pollAfterMsFor(position: number, rand: () => number = Math.random): number {
  const base = position <= 10 ? 2_000 : position <= 50 ? 5_000 : position <= 200 ? 8_000 : position <= 1_000 ? 12_000 : 20_000;
  return Math.round(base * (0.8 + rand() * 0.4));
}

export async function sweepAndAdmit(eventId: string, concurrentSlots: number, windowSeconds: number, opts: { minIntervalMs?: number } = {}): Promise<void> {
  const key = throttleKey(eventId);
  if (opts.minIntervalMs) {
    const now = sweepClock();
    const last = lastSweepAt.get(key);
    if (last !== undefined && now - last < opts.minIntervalMs) return;
    if (lastSweepAt.size >= MAX_THROTTLE_ENTRIES) lastSweepAt.clear();
    // Se marca antes de barrer: las llamadas simultáneas de esta instancia no repiten el trabajo.
    lastSweepAt.set(key, now);
  }
  opportunisticCleanup(eventId);

  try {
    await runSweep(eventId, concurrentSlots, windowSeconds);
  } catch (err) {
    // Si el barrido falló no cuenta como hecho: el siguiente sondeo debe poder reintentarlo.
    lastSweepAt.delete(key);
    throw err;
  }
}

/* Latido (H-071). Quien espera sondea cada 2-24 s (lo decide el servidor, ver `pollAfterMsFor`) y cada sondeo refresca `lastSeenAt`. Solo se ADMITE
 * (y solo se cuenta en la posición) a quien ha sondeado hace poco: antes los turnos abandonados —pestañas cerradas— se admitían igualmente y retenían
 * hueco hasta caducar, que con miles en cola eran horas de huecos muertos. 2 minutos cubren con holgura el sondeo más lento (24 s) y un navegador que
 * ralentiza las pestañas ocultas (~1 sondeo por minuto). Sin latido durante 15 minutos la espera caduca; si vuelve, entra de nuevo por detrás.
 * Una fila sin `lastSeenAt` (la creó un front anterior) cuenta como vista al entrar. */
export const QUEUE_ALIVE_SECONDS = 120;
export const QUEUE_ABANDON_SECONDS = 15 * 60;
/** Cada cuánto se refresca como máximo el latido de una misma entrada (el sondeo más rápido es de ~1,6 s: no hace falta escribir en cada uno). */
export const QUEUE_HEARTBEAT_MIN_INTERVAL_MS = 15_000;

/** Condición de Prisma: entradas WAITING que siguen ahí (para contar la posición). */
export function liveWaitingWhere(now = new Date()) {
  const since = new Date(now.getTime() - QUEUE_ALIVE_SECONDS * 1000);
  return { status: 'WAITING' as const, OR: [{ lastSeenAt: { gte: since } }, { lastSeenAt: null, joinedAt: { gte: since } }] };
}

/** Refresca el latido de una entrada que espera (como mucho una vez cada `QUEUE_HEARTBEAT_MIN_INTERVAL_MS`). Nunca lanza: no es crítico. */
export async function touchWaitingEntry(where: { id: string } | { token: string; eventId: string }): Promise<void> {
  const stale = new Date(Date.now() - QUEUE_HEARTBEAT_MIN_INTERVAL_MS);
  try {
    await prisma.waitingRoomEntry.updateMany({ where: { ...where, status: 'WAITING', OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: stale } }] }, data: { lastSeenAt: new Date() } });
  } catch (error) {
    console.error('[waiting-room] no se pudo refrescar el latido:', error instanceof Error ? error.message : error);
  }
}

async function runSweep(eventId: string, concurrentSlots: number, windowSeconds: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId} || ':queue'))`;

    await tx.$executeRaw`
      UPDATE "WaitingRoomEntry" SET status = 'EXPIRED'
      WHERE "eventId" = ${eventId} AND status = 'ADMITTED' AND "expiresAt" < now()`;

    // Esperas sin latido desde hace mucho: nadie las está mirando.
    await tx.$executeRaw`
      UPDATE "WaitingRoomEntry" SET status = 'EXPIRED'
      WHERE "eventId" = ${eventId} AND status = 'WAITING'
        AND COALESCE("lastSeenAt", "joinedAt") < now() - (${QUEUE_ABANDON_SECONDS}::text || ' seconds')::interval`;

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
            AND COALESCE("lastSeenAt", "joinedAt") > now() - (${QUEUE_ALIVE_SECONDS}::text || ' seconds')::interval
          ORDER BY "joinedAt" ASC
          LIMIT ${freeSlots}
        )`;
    }
  });
}
