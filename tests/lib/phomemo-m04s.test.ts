import { describe, it, expect } from 'vitest';
import { imageDataToMonoRaster, TICKET_BLACK_THRESHOLD } from '@/lib/phomemo/raster';
import {
  m04DensityByte,
  m04HeatByte,
  m04RasterHeader,
  buildM04SCommandSequence,
} from '@/lib/phomemo/m04s-protocol';
import { M04S_PAPER } from '@/lib/phomemo/constants';

function rgba(width: number, height: number, fill: [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return data;
}

describe('M04S protocol', () => {
  it('codifica densidad y calor como phomymo (density 6)', () => {
    expect(m04DensityByte(6)).toBe(11);
    expect(m04HeatByte(6)).toBe(183);
  });

  it('arma el header raster GS v 0 con ancho 16-bit little-endian', () => {
    const header = m04RasterHeader(154, 821);
    expect(Array.from(header)).toEqual([0x1d, 0x76, 0x30, 0x00, 154, 0, 821 % 256, Math.floor(821 / 256)]);
  });

  it('antepone init M04 y el bitmap al trabajo de impresión', () => {
    const raster = {
      width: 16,
      height: 1,
      bytesPerRow: 2,
      bits: new Uint8Array([0xff, 0x00]),
    };
    const job = buildM04SCommandSequence(raster);
    expect(job.preamble[0]).toEqual(new Uint8Array([0x1f, 0x11, 0x02, 11]));
    expect(job.preamble[2]).toEqual(new Uint8Array([0x1f, 0x11, 0x0b]));
    expect(job.raster).toEqual(raster.bits);
    expect(job.feed.length).toBe(2);
  });
});

describe('raster térmico', () => {
  it('el fondo lima no se quema (papel térmico blanco)', () => {
    const data = rgba(8, 1, [197, 230, 58, 255]);
    const raster = imageDataToMonoRaster({ width: 8, height: 1, data }, 1, TICKET_BLACK_THRESHOLD);
    expect(raster.bits[0]).toBe(0);
  });

  it('el negro del QR sí se quema', () => {
    const data = rgba(8, 1, [0, 0, 0, 255]);
    const raster = imageDataToMonoRaster({ width: 8, height: 1, data }, 1, TICKET_BLACK_THRESHOLD);
    expect(raster.bits[0]).toBe(0xff);
  });

  it('el papel de 110 mm usa 154 bytes por fila', () => {
    expect(M04S_PAPER.widthBytes).toBe(154);
    expect(M04S_PAPER.widthPx).toBe(1232);
  });
});

describe('BLE M04S', () => {
  it('el bitmap se trocea en 256 bytes como phomymo por defecto', async () => {
    const { DEFAULT_PRINT_SETTINGS } = await import('@/lib/phomemo/constants');
    expect(DEFAULT_PRINT_SETTINGS.rasterChunkSize).toBe(256);
  });
});
