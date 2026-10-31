import { parseMadridLocal } from '@/lib/event-time';

/** Clave compartida entre /admin/noche y /acceso para recordar el evento activo. */
export const ACTIVE_EVENT_STORAGE_KEY = 'la-grailla-active-event';

export function getStoredActiveEventId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(ACTIVE_EVENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredActiveEventId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ACTIVE_EVENT_STORAGE_KEY, id);
  } catch {
    // localStorage bloqueado (modo privado, etc.)
  }
}

/** Margen tras la hora de inicio durante el cual un evento nocturno se considera "en curso". */
export const EVENT_GRACE_PERIOD_MS = 6 * 60 * 60 * 1000;

/** Hasta cuánto después de empezar puede seguir un evento con hora de fin (la noche más larga que cabe en el formulario: termina como mucho 24 h después). Para acotar consultas; la decisión fina es de `hasEventEnded`. */
export const EVENT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const MADRID = 'Europe/Madrid';

function madridDateKey(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: MADRID });
}

function parseEventDate(date: Date | string | null | undefined): Date | null {
  if (!date) return null;
  const parsed = date instanceof Date ? date : new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Elige el evento publicado más relevante para operar en puerta. */
export function pickDefaultActiveEventId<
  T extends { id: string; date?: Date | string | null; status?: string | null; endTime?: string | null }
>(events: T[]): string {
  const published = (events ?? []).filter((e) => !e.status || e.status === 'PUBLISHED');
  const pool = published.length ? published : (events ?? []);
  if (!pool.length) return '';

  // H-079: lo que está EN MARCHA manda sobre «el de hoy». A las 00:30 la noche de las 22:00 es de «ayer» en Madrid: sin esto, con otro evento al día
  // siguiente, la puerta elegía el equivocado. Con varios en marcha, el que empezó antes (el mismo desempate de siempre).
  const nowMs = Date.now();
  const inProgress = pool
    .map((e) => ({ e, t: parseEventDate(e.date)?.getTime() }))
    .filter((x): x is { e: T; t: number } => x.t !== undefined && x.t <= nowMs && !hasEventEnded(x.e.date, x.e.endTime))
    .sort((a, b) => a.t - b.t);
  if (inProgress.length) return inProgress[0].e.id;

  const todayKey = madridDateKey(new Date());

  const todayEvents = pool.filter((e) => {
    const d = parseEventDate(e.date);
    return d && madridDateKey(d) === todayKey;
  });
  if (todayEvents.length === 1) return todayEvents[0].id;
  if (todayEvents.length > 1) {
    return [...todayEvents].sort((a, b) => {
      const da = parseEventDate(a.date)?.getTime() ?? 0;
      const db = parseEventDate(b.date)?.getTime() ?? 0;
      return da - db;
    })[0].id;
  }

  const now = Date.now();
  const upcoming = pool
    .map((e) => ({ e, t: parseEventDate(e.date)?.getTime() ?? 0 }))
    .filter(({ t }) => t >= now - EVENT_GRACE_PERIOD_MS)
    .sort((a, b) => a.t - b.t);
  if (upcoming.length) return upcoming[0].e.id;

  const byRecent = [...pool].sort((a, b) => {
    const da = parseEventDate(a.date)?.getTime() ?? 0;
    const db = parseEventDate(b.date)?.getTime() ?? 0;
    return db - da;
  });
  return byRecent[0]?.id ?? '';
}

/**
 * Un evento se considera finalizado a efectos de venta/cartelería pública
 * cuando ya pasó su hora de inicio + el margen de gracia nocturno (el mismo
 * usado para elegir el evento activo en /acceso). Sin este corte, un evento
 * PUBLISHED con fecha pasada se seguía anunciando y vendiendo indefinidamente.
 */
export function hasEventEnded(date: Date | string | null | undefined, endTime?: string | null): boolean {
  const d = parseEventDate(date);
  if (!d) return false;
  // H-079: con hora de fin, un evento 16:00–04:00 no «termina» a las 22:00 (inicio + margen): dura hasta las 04:00. La hora de fin nunca acorta el margen.
  const end = eventEndInstant(date, endTime);
  const until = Math.max(d.getTime() + EVENT_GRACE_PERIOD_MS, end?.getTime() ?? 0);
  return Date.now() > until;
}

/**
 * Instante en que termina el evento según su hora de fin (`Event.endTime`, texto libre `HH:mm` en hora de Madrid), o null si está vacía o no se entiende.
 * Si la hora de fin es anterior o igual a la de inicio, termina al día siguiente (la noche cruza la medianoche).
 */
export function eventEndInstant(date: Date | string | null | undefined, endTime: string | null | undefined): Date | null {
  const start = parseEventDate(date);
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(endTime ?? '');
  if (!start || !m) return null;
  const hour = Number(m[1]);
  if (hour > 23 || Number(m[2]) > 59) return null;
  const clock = `${String(hour).padStart(2, '0')}:${m[2]}`;
  const sameDay = parseMadridLocal(`${madridDateKey(start)}T${clock}`);
  if (!sameDay) return null;
  if (sameDay.getTime() > start.getTime()) return sameDay;
  const [y, mo, d] = madridDateKey(start).split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return parseMadridLocal(`${nextDay}T${clock}`);
}

export function isEventTonight(date: Date | string | null | undefined, endTime?: string | null): boolean {
  const d = parseEventDate(date);
  if (!d) return false;
  const todayKey = madridDateKey(new Date());
  if (madridDateKey(d) === todayKey) return true;
  const diff = d.getTime() - Date.now();
  if (diff >= 0) return diff <= 12 * 60 * 60 * 1000;
  // Ya empezó (otro día en Madrid): a las 00:30 la noche de las 22:00 sigue en marcha hasta que termine (margen o hora de fin). Antes desaparecía a medianoche.
  return !hasEventEnded(date, endTime);
}
