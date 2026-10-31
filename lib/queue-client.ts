/* Lógica pura del cliente de la sala de espera (revisión integral, lote 2b). Vive aparte del componente para poder probarla sin navegador. */

// --- H-090: «servicio ocupado» no es «sin conexión» --------------------------------------------------------------------------------------------------
// En un lanzamiento lo esperado es que el servidor conteste 429 o 5xx durante un rato. Eso NO es un fallo de red: el turno sigue vivo y basta con reintentar
// con calma. Contarlo como fallo de red llevaba a «Sin conexión con la cola. Revisa la red» a los 4 intentos, que es falso y asusta al comprador.

export function isBusyStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const BUSY_MIN_MS = 2000;
const BUSY_MAX_MS = 30000;
const BUSY_DEFAULT_MS = 5000;
const BUSY_JITTER_MS = 1000;

/** Espera antes de reintentar tras un «ocupado»: lo que pida `Retry-After` (segundos), acotado a 2–30 s, más una dispersión para que no vuelvan todos a la vez. */
export function busyRetryMs(retryAfterSeconds: number | null, rand: () => number = Math.random): number {
  const asked = retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : BUSY_DEFAULT_MS;
  return Math.min(BUSY_MAX_MS, Math.max(BUSY_MIN_MS, asked)) + Math.floor(rand() * BUSY_JITTER_MS);
}

/** Cuerpo JSON de la respuesta o null si no lo es (un 502 de la plataforma trae HTML): quien llama decide con el código HTTP y las cabeceras. */
export async function readJsonSafe<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// --- H-102: almacenamiento bloqueado ------------------------------------------------------------------------------------------------------------------
// Con el almacenamiento bloqueado (modo privado de algún navegador, cookies desactivadas) `localStorage.getItem` lanza. Antes eso dejaba una promesa
// rechazada y al comprador en «Comprobando…» hasta el aviso de lentitud. El turno se recuerda también en memoria: sin persistencia entre recargas, pero la cola funciona.

export function createTokenStore(storageOf: () => Storage | null = () => (typeof window === 'undefined' ? null : window.localStorage)) {
  const memory = new Map<string, string>();
  const key = (eventId: string) => `queue_token_${eventId}`;
  return {
    get(eventId: string): string | null {
      try {
        const stored = storageOf()?.getItem(key(eventId));
        if (stored != null) return stored;
      } catch {
        /* bloqueado: se usa la memoria */
      }
      return memory.get(eventId) ?? null;
    },
    set(eventId: string, token: string): void {
      memory.set(eventId, token);
      try {
        storageOf()?.setItem(key(eventId), token);
      } catch {
        /* bloqueado: queda en memoria */
      }
    },
    remove(eventId: string): void {
      memory.delete(eventId);
      try {
        storageOf()?.removeItem(key(eventId));
      } catch {
        /* nada que borrar */
      }
    },
  };
}

// --- H-091 / H-092: cuenta atrás ---------------------------------------------------------------------------------------------------------------------

/** Aviso para lectores de pantalla al cruzar 60 s y 10 s (no cada segundo). Con un salto que se coma ambos umbrales manda el más cercano. */
export function countdownAnnouncement(previousSeconds: number, seconds: number): string | null {
  if (previousSeconds > 10 && seconds <= 10) return 'Quedan 10 segundos para completar la compra.';
  if (previousSeconds > 60 && seconds <= 60) return 'Queda un minuto para completar la compra.';
  return null;
}

/**
 * Milisegundos que le quedan al turno. Con el tiempo restante que manda el servidor (`remainingMs`, medido al responder) se descuenta lo transcurrido en
 * el reloj MONÓTONO del navegador desde que llegó: un dispositivo con la hora adelantada o atrasada ya no acorta ni alarga la cuenta atrás. Sin él
 * (servidor anterior) cae a la hora de caducidad y el reloj local, como antes.
 */
export function remainingFrom(info: { remainingMs?: number; expiresAt: string }, receivedPerfMs: number, nowPerfMs: number, nowWallMs: number): number {
  if (typeof info.remainingMs === 'number' && Number.isFinite(info.remainingMs)) return info.remainingMs - (nowPerfMs - receivedPerfMs);
  return new Date(info.expiresAt).getTime() - nowWallMs;
}
