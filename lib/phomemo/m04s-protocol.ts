import { M04S_PRINT, PHOMEMO_BLE } from './constants';
import type { MonoRaster } from './raster';

/**
 * Protocolo M04S/M04AS (300 DPI), extraído de phomymo
 * (transcriptionstream/phomymo, src/web/printer.js — logs BTSnoop, issue #23).
 * No es ESC/POS genérico: init 0x1F 0x11 … y raster GS v 0 con ancho 16-bit LE.
 */

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

export function m04DensityByte(density: number): number {
  return Math.round((density / 8) * 15);
}

export function m04HeatByte(density: number): number {
  return Math.round(100 + (density - 1) * (50 / 3));
}

export function m04RasterHeader(widthBytes: number, heightLines: number): Uint8Array {
  return new Uint8Array([
    0x1d, 0x76, 0x30, 0x00,
    widthBytes % 256,
    Math.floor(widthBytes / 256),
    heightLines % 256,
    Math.floor(heightLines / 256),
  ]);
}

export function buildM04SCommandSequence(
  raster: MonoRaster,
  opts: { density?: number; feed?: number } = {}
): { preamble: Uint8Array[]; raster: Uint8Array; feed: Uint8Array[]; delays: { command: number; rasterChunk: number; afterRaster: number; afterFeed: number } } {
  const density = opts.density ?? M04S_PRINT.density;
  const feed = opts.feed ?? M04S_PRINT.feed;
  const feedCount = Math.max(1, Math.round(feed / 16));

  return {
    preamble: [
      new Uint8Array([0x1f, 0x11, 0x02, m04DensityByte(density)]),
      new Uint8Array([0x1f, 0x11, 0x37, m04HeatByte(density)]),
      new Uint8Array([0x1f, 0x11, 0x0b]),
      new Uint8Array([0x1f, 0x11, 0x35, 0x00]),
      m04RasterHeader(raster.bytesPerRow, raster.height),
    ],
    raster: raster.bits,
    feed: Array.from({ length: feedCount }, () => new Uint8Array([0x1b, 0x64, 0x02])),
    delays: {
      command: PHOMEMO_BLE.COMMAND_DELAY_MS,
      rasterChunk: PHOMEMO_BLE.CHUNK_DELAY_MS,
      afterRaster: 300,
      afterFeed: 500,
    },
  };
}

export { concatBytes };
