export type MonoRaster = {
  width: number;
  height: number;
  bits: Uint8Array;
  bytesPerRow: number;
};

/** Lima ~200 de luminancia: por encima del umbral no se quema (el térmica es blanco/negro). */
export const TICKET_BLACK_THRESHOLD = 160;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Empaqueta RGBA en bitmap 1-bit (MSB primero, 1 = negro = imprime).
 * Umbral, no dither: el QR tiene que seguir siendo escaneable.
 */
export function imageDataToMonoRaster(
  imageData: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  targetBytesPerRow: number,
  threshold = TICKET_BLACK_THRESHOLD
): MonoRaster {
  const srcW = imageData.width;
  const srcH = imageData.height;
  const width = targetBytesPerRow * 8;
  const bits = new Uint8Array(targetBytesPerRow * srcH);

  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= srcW) continue;
      const i = (y * srcW + x) * 4;
      const gray = luminance(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]);
      if (gray < threshold) {
        const byteIndex = y * targetBytesPerRow + (x >> 3);
        bits[byteIndex] |= 0x80 >> (x % 8);
      }
    }
  }

  return { width, height: srcH, bits, bytesPerRow: targetBytesPerRow };
}

export function canvasToMonoRaster(canvas: HTMLCanvasElement, targetBytesPerRow: number): MonoRaster {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo leer el canvas de la entrada');
  return imageDataToMonoRaster(ctx.getImageData(0, 0, canvas.width, canvas.height), targetBytesPerRow);
}
