/* Zona horaria en la que se muestran los días y horas de los eventos en la web pública. El servidor corre en UTC (Vercel) y cada visitante en la
 * suya: sin fijarla, un evento a las 00:30 del sábado en Madrid salía como «viernes» (UTC) o con el día según el país del visitante. Entradas, PDF
 * y wallet ya usan Madrid; la web pública debe decir lo mismo. */
export const EVENT_TIMEZONE = 'Europe/Madrid';

/* Hora «de pared» de Madrid ⇄ instante. El formulario del admin usa `datetime-local` (sin zona) y el servidor corre en UTC: tratarlo con
 * `new Date(valor)` guardaba «23:30» como 23:30Z, que la web, el email, el PDF y Wallet (todos en Madrid) enseñan como 00:30/01:30 del día
 * siguiente. Estas funciones no dependen de la zona del proceso: solo de `Intl` con `timeZone` explícito. */

const DAY_MS = 24 * 60 * 60 * 1000;

let wallClockFormat: Intl.DateTimeFormat | null = null;

/** Hora de pared de `instant` en Madrid (año, mes, día, hora, minuto, segundo). */
function madridWallClock(instant: number) {
  wallClockFormat ??= new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of wallClockFormat.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Desfase de Madrid respecto a UTC (ms) en `instant`: +1 h en invierno, +2 h en verano. */
function madridOffsetMs(instant: number): number {
  const w = madridWallClock(instant);
  // Los milisegundos se descartan: Intl solo da segundos, y el desfase es siempre de minutos enteros.
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** `YYYY-MM-DDTHH:mm` (hora de pared de Madrid) de un instante, el formato del `value` de un `<input type="datetime-local">`. '' si no es una fecha válida. */
export function formatMadridLocal(date: Date | string | number | null | undefined): string {
  if (date == null || date === '') return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const w = madridWallClock(d.getTime());
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** `HH:mm` en Madrid de un instante (hora de entrada en puerta…). 'N/A' si no hay instante válido. */
export function formatMadridTime(date: Date | string | number | null | undefined): string {
  const local = formatMadridLocal(date);
  return local ? local.slice(11) : 'N/A';
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;

/**
 * Interpreta `YYYY-MM-DDTHH:mm[:ss[.SSS]]` (o solo `YYYY-MM-DD`, que vale 00:00) como hora de pared de Madrid y devuelve el instante.
 * Null si no tiene ese formato o el día no existe (30 de febrero…). En los cambios de hora: una hora repetida (la de las 02:00-02:59 del
 * último domingo de octubre) se resuelve a la primera, la de verano; una hora inexistente (02:00-02:59 del último domingo de marzo) se
 * corre hacia delante, como hace `Temporal` por defecto (02:30 → 03:30).
 */
export function parseMadridLocal(value: string): Date | null {
  const m = LOCAL_RE.exec((value ?? '').trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second, millis] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0', (m[7] ?? '0').padEnd(3, '0')].map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(wall);
  // Date.UTC desborda en silencio (mes 13, día 31 de abril, hora 25): se exige que el día y la hora leídos sean los dados.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;

  // Los dos desfases posibles alrededor de ese día (antes y después de un posible cambio de hora). El instante válido es el que, visto en
  // Madrid, vuelve a dar la misma hora de pared; si vale más de uno (hora repetida) gana el primero; si ninguno (hora inexistente), el desfase previo.
  const before = madridOffsetMs(wall - DAY_MS);
  const after = madridOffsetMs(wall + DAY_MS);
  const target = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  const valid = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => formatMadridLocal(instant) === target)
    .sort((a, b) => a - b);
  return new Date(valid[0] ?? wall - before);
}

/** Fecha y hora seguidas de un designador de zona (`Z`, `+02:00`, `-0500`, `+02`). */
const ZONE_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?)$/i;

/**
 * Fecha de un evento recibida como texto. Sin designador de zona (lo que envía el `datetime-local` del admin) se interpreta como hora de
 * Madrid; con `Z` u offset (scripts, seeds, otras integraciones) se respeta tal cual. Null si no es una fecha válida.
 */
export function parseEventDateInput(value: string): Date | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const zoned = ZONE_RE.exec(text);
  if (zoned) {
    // Se normaliza a ISO estricto (`T`, offset `±HH:mm`) para que no dependa de lo permisivo que sea `Date.parse` con cada variante.
    const [, day, time, utc, sign, hh, mm] = zoned;
    const d = new Date(`${day}T${time}${utc ? 'Z' : `${sign}${hh}:${mm ?? '00'}`}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return parseMadridLocal(text);
}
