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
  /**
   * phomymo (transcriptionstream/phomymo, protocolo M04 probado en hardware real,
   * github.com/transcriptionstream/phomymo/issues/23) envía en bloques de 256.
   * Se probó bajar a 20 (límite del MTU BLE por defecto sin negociar) pensando en
   * un truncado silencioso en Android, pero no arregló la impresión corrupta —
   * así que se mantiene el valor de la referencia, que sí está validado en M04S.
   */
  RASTER_CHUNK_SIZE: 256,
  CHUNK_DELAY_MS: 20,
  COMMAND_DELAY_MS: 30,
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

export const M04S_PRINT = {
  density: 6,
  feed: 32,
} as const;

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export function isLikelyIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
