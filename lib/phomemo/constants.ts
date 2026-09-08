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
 * 'auto' manda la mayoría del ráster sin confirmar (rápido) pero intercala
 * confirmaciones reales cada `confirmEveryChunks` bloques (ver
 * PhomemoPrintSettings) — un punto intermedio entre 'with_response' (fiable pero
 * demasiado lento: en pruebas reales, 260 escrituras confirmadas tardaron 25-60s y
 * la impresora cortó el trabajo a mitad antes de terminar, probablemente por un
 * timeout interno del propio firmware) y 'without_response' puro (rápido pero en
 * Android puede perder bytes en silencio y salir con ruido). 'with_response' fuerza
 * confirmación en cada escritura — el modo más fiable pero el más lento y el único
 * que ha mostrado cortarse a mitad en dispositivos lentos. 'without_response' fuerza
 * el modo rápido siempre, sin ninguna comprobación real.
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
  /**
   * Solo aplica en modo 'auto' cuando el navegador soporta writeValueWithResponse()
   * real: cada N bloques de ráster se manda confirmado en vez de rápido, para que la
   * impresora demuestre que sigue el ritmo sin pagar el coste de confirmar los 250+
   * bloques uno a uno. 0 desactiva los checkpoints (auto se comporta como antes).
   */
  confirmEveryChunks: number;
};

/**
 * Estado real de la última impresión — para diagnosticar en el propio dispositivo
 * (la tablet de taquilla no tiene devtools a mano) por qué salió con ruido o
 * incompleta, sin tener que adivinar a distancia.
 */
export type PhomemoPrintDiagnostics = {
  writeModeRequested: PhomemoWriteMode;
  chunksWithResponse: number;
  chunksWithoutResponse: number;
  retries: number;
  rasterChunks: number;
  notifySubscribed: boolean;
  // false = este navegador solo tiene el writeValue() ambiguo, que en algunos
  // Android hace en realidad "sin confirmación" aunque se le pida confirmar.
  // Ver comentario en ble.ts junto a writeValueWithResponse.
  explicitConfirmedWriteSupported: boolean;
  pages: number;
  totalPages: number;
  durationMs: number;
  error: string | null;
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
  confirmEveryChunks: 8,
};

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export function isLikelyIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
