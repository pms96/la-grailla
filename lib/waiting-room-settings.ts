/* Ajustes numéricos de la sala de espera de un evento (H-076). Antes cada ruta hacía `event.x ?? DEFAULT` y `Number(body.x)`: un 0 guardado paraba la cola
 * (0 huecos ⇒ nadie admitido; ventana 0 ⇒ cada turno nacía caducado) y `Number('abc')` o un decimal llegaban a Prisma y acababan en 500. Aquí vive la regla
 * única: al ESCRIBIR se rechaza lo que no sea un entero en rango; al LEER, lo ya guardado fuera de rango (datos de antes) cae al valor por defecto. */

export type IntLimits = { min: number; max: number; default: number; label: string };

export const WAITING_ROOM_LIMITS = {
  slots: { min: 1, max: 1000, default: 20, label: 'Huecos simultáneos' },
  // En segundos; el formulario lo pide en minutos (de 0,5 a 60).
  windowSeconds: { min: 30, max: 3600, default: 300, label: 'Tiempo para comprar' },
} as const satisfies Record<string, IntLimits>;

function inRange(value: unknown, limits: IntLimits): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= limits.min && value <= limits.max;
}

/** Valor efectivo para la cola: el guardado si es válido; si no (nulo, 0, decimal, fuera de rango), el de por defecto. */
export function waitingRoomSettings(event: { waitingRoomConcurrentSlots: number | null; waitingRoomPurchaseWindowSeconds: number | null }) {
  const { slots, windowSeconds } = WAITING_ROOM_LIMITS;
  return {
    concurrentSlots: inRange(event.waitingRoomConcurrentSlots, slots) ? event.waitingRoomConcurrentSlots : slots.default,
    windowSeconds: inRange(event.waitingRoomPurchaseWindowSeconds, windowSeconds) ? event.waitingRoomPurchaseWindowSeconds : windowSeconds.default,
  };
}

const MAX_TICKETS_PER_EMAIL_LIMITS = { min: 1, max: 1000, label: 'Máximo de entradas por correo' } as const;

type EventNumberInput = { maxTicketsPerEmail?: unknown; waitingRoomConcurrentSlots?: unknown; waitingRoomPurchaseWindowSeconds?: unknown };
export type ParsedEventNumbers =
  | { ok: true; maxTicketsPerEmail: number | null | undefined; waitingRoomConcurrentSlots: number | null | undefined; waitingRoomPurchaseWindowSeconds: number | null | undefined }
  | { ok: false; error: string };

/** Los tres números enteros del formulario de evento, validados de una vez (alta y edición comparten la regla). */
export function parseEventNumberSettings(body: EventNumberInput): ParsedEventNumbers {
  const max = parseIntSetting(body.maxTicketsPerEmail, MAX_TICKETS_PER_EMAIL_LIMITS);
  const slots = parseIntSetting(body.waitingRoomConcurrentSlots, WAITING_ROOM_LIMITS.slots);
  const windowSeconds = parseIntSetting(body.waitingRoomPurchaseWindowSeconds, WAITING_ROOM_LIMITS.windowSeconds);
  for (const parsed of [max, slots, windowSeconds]) if (!parsed.ok) return parsed;
  if (!max.ok || !slots.ok || !windowSeconds.ok) return { ok: false, error: 'Valor numérico no válido' };
  return { ok: true, maxTicketsPerEmail: max.value, waitingRoomConcurrentSlots: slots.value, waitingRoomPurchaseWindowSeconds: windowSeconds.value };
}

export type ParsedIntSetting = { ok: true; value: number | null | undefined } | { ok: false; error: string };

/** Valida lo que llega del formulario: `undefined` = no tocar, `''`/`null` = sin valor (se usará el de por defecto), otro = entero en rango. */
export function parseIntSetting(raw: unknown, limits: Pick<IntLimits, 'min' | 'max' | 'label'>): ParsedIntSetting {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
  if (typeof n === 'number' && Number.isInteger(n) && n >= limits.min && n <= limits.max) return { ok: true, value: n };
  return { ok: false, error: `${limits.label}: indica un número entero entre ${limits.min} y ${limits.max}.` };
}
