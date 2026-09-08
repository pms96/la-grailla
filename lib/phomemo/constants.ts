/** Phomemo M04S — constantes BLE y papel (phomymo / ingeniería inversa). */

export const PHOMEMO_BLE = {
  SERVICE_UUID: 0xff00,
  WRITE_CHAR_UUID: 0xff02,
  NOTIFY_CHAR_UUID: 0xff03,
  ALT_SERVICE_UUIDS: [
    0xff00,
    0xffe0,
    '0000ff00-0000-1000-8000-00805f9b34fb',
  ] as const,
  MAX_RETRIES: 1,
  INITIAL_RETRY_DELAY_MS: 300,
} as const;

/** 300 DPI. 154 bytes × 8 = 1232 px ≈ 104 mm — encaja el tique de 105 × 70. */
export const M04S_PAPER = {
  dpi: 300,
  widthBytes: 154,
  widthPx: 154 * 8,
  ticketWidthMm: 105,
  ticketHeightMm: 70,
} as const;

/**
 * 'auto' deja que cada escritura elija por sí sola (rápido, pero en algunos Android
 * la escritura "sin confirmación" se pierde en silencio y el ráster llega corrupto).
 * 'with_response' fuerza confirmación en cada escritura: mucho más lento pero fiable
 * — es el modo al que cae 'auto' tras el primer fallo, así que fijarlo evita que la
 * primera impresión de una sesión salga incompleta o con ruido antes de que el
 * fallback reactivo se active. 'without_response' fuerza el modo rápido siempre.
 */
export type PhomemoWriteMode = 'auto' | 'with_response' | 'without_response';

export type PhomemoPrintSettings = {
  writeMode: PhomemoWriteMode;
  rasterChunkSize: number;
  chunkDelayMs: number;
  commandDelayMs: number;
  afterRasterDelayMs: number;
  afterFeedDelayMs: number;
  density: number;
  feed: number;
};

/**
 * Valores de fábrica — los mismos que ya estaban probados en hardware real (phomymo,
 * transcriptionstream/phomymo, issue #23) antes de hacerlos configurables desde
 * /admin/configuracion. Sirven de respaldo si /api/taquilla/print-settings falla.
 */
export const DEFAULT_PRINT_SETTINGS: PhomemoPrintSettings = {
  writeMode: 'auto',
  rasterChunkSize: 256,
  chunkDelayMs: 20,
  commandDelayMs: 30,
  afterRasterDelayMs: 300,
  afterFeedDelayMs: 500,
  density: 6,
  feed: 32,
};

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export function isLikelyIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
