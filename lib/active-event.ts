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
  T extends { id: string; date?: Date | string | null; status?: string | null }
>(events: T[]): string {
  const published = (events ?? []).filter((e) => !e.status || e.status === 'PUBLISHED');
  const pool = published.length ? published : (events ?? []);
  if (!pool.length) return '';

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
    .filter(({ t }) => t >= now - 6 * 60 * 60 * 1000)
    .sort((a, b) => a.t - b.t);
  if (upcoming.length) return upcoming[0].e.id;

  const byRecent = [...pool].sort((a, b) => {
    const da = parseEventDate(a.date)?.getTime() ?? 0;
    const db = parseEventDate(b.date)?.getTime() ?? 0;
    return db - da;
  });
  return byRecent[0]?.id ?? '';
}

export function isEventTonight(date: Date | string | null | undefined): boolean {
  const d = parseEventDate(date);
  if (!d) return false;
  const todayKey = madridDateKey(new Date());
  if (madridDateKey(d) === todayKey) return true;
  const diff = d.getTime() - Date.now();
  return diff >= 0 && diff <= 12 * 60 * 60 * 1000;
}
