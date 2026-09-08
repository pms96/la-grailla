import { DEFAULT_PRINT_SETTINGS, type PhomemoPrintSettings, type PhomemoWriteMode } from './constants';

const WRITE_MODES: PhomemoWriteMode[] = ['auto', 'with_response', 'without_response'];

function isWriteMode(value: unknown): value is PhomemoWriteMode {
  return typeof value === 'string' && (WRITE_MODES as string[]).includes(value);
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Trae los parámetros de impresión BLE desde /admin/configuracion (tab "Impresora").
 * Nunca lanza: si el fetch falla (sin red, taquilla offline, etc.) se sigue
 * imprimiendo con los valores de fábrica en vez de bloquear la venta.
 */
export async function fetchPhomemoPrintSettings(): Promise<PhomemoPrintSettings> {
  try {
    const res = await fetch('/api/taquilla/print-settings');
    if (!res.ok) return DEFAULT_PRINT_SETTINGS;
    const data = await res.json();
    return {
      writeMode: isWriteMode(data?.writeMode) ? data.writeMode : DEFAULT_PRINT_SETTINGS.writeMode,
      rasterChunkSize: numberOr(data?.rasterChunkSize, DEFAULT_PRINT_SETTINGS.rasterChunkSize),
      chunkDelayMs: numberOr(data?.chunkDelayMs, DEFAULT_PRINT_SETTINGS.chunkDelayMs),
      commandDelayMs: numberOr(data?.commandDelayMs, DEFAULT_PRINT_SETTINGS.commandDelayMs),
      afterRasterDelayMs: numberOr(data?.afterRasterDelayMs, DEFAULT_PRINT_SETTINGS.afterRasterDelayMs),
      afterFeedDelayMs: numberOr(data?.afterFeedDelayMs, DEFAULT_PRINT_SETTINGS.afterFeedDelayMs),
      density: numberOr(data?.density, DEFAULT_PRINT_SETTINGS.density),
      feed: numberOr(data?.feed, DEFAULT_PRINT_SETTINGS.feed),
    };
  } catch {
    return DEFAULT_PRINT_SETTINGS;
  }
}
