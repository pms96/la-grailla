import { describe, expect, it } from 'vitest';
import { UPLOAD_IMAGE_MAX_SIDE, UPLOAD_JPEG_HEAVY_BYTES, UPLOAD_JPEG_QUALITY, fileNameForType, isResizableType, planImageResize } from '@/lib/images/resize-plan';

const KB = 1024;

describe('planImageResize', () => {
  it('una foto de cámara (JPEG de 4000×3000) se reduce al lado máximo manteniendo la proporción', () => {
    const plan = planImageResize({ type: 'image/jpeg', size: 4_000 * KB, width: 4000, height: 3000 });
    expect(plan).toEqual({ width: UPLOAD_IMAGE_MAX_SIDE, height: 1200, type: 'image/jpeg', quality: UPLOAD_JPEG_QUALITY });
  });

  it('una foto vertical se reduce por el lado alto', () => {
    expect(planImageResize({ type: 'image/jpeg', size: 3_000 * KB, width: 3000, height: 4000 })).toMatchObject({ width: 1200, height: UPLOAD_IMAGE_MAX_SIDE });
  });

  it('un JPEG que ya cabe y es ligero se sube tal cual', () => {
    expect(planImageResize({ type: 'image/jpeg', size: 300 * KB, width: 1200, height: 800 })).toBeNull();
    expect(planImageResize({ type: 'image/jpeg', size: UPLOAD_JPEG_HEAVY_BYTES, width: UPLOAD_IMAGE_MAX_SIDE, height: 900 })).toBeNull();
  });

  it('un JPEG que cabe pero pesa demasiado se recodifica sin cambiar de tamaño', () => {
    expect(planImageResize({ type: 'image/jpeg', size: UPLOAD_JPEG_HEAVY_BYTES + 1, width: 1500, height: 1000 })).toEqual({ width: 1500, height: 1000, type: 'image/jpeg', quality: UPLOAD_JPEG_QUALITY });
  });

  it('PNG y WebP (logos con transparencia) solo se tocan si exceden el lado máximo, y conservan su formato', () => {
    expect(planImageResize({ type: 'image/png', size: 5_000 * KB, width: 1200, height: 1200 })).toBeNull(); // pesado pero cabe: no se recodifica
    expect(planImageResize({ type: 'image/png', size: 5_000 * KB, width: 3200, height: 1600 })).toEqual({ width: UPLOAD_IMAGE_MAX_SIDE, height: 800, type: 'image/png', quality: undefined });
    expect(planImageResize({ type: 'image/webp', size: 900 * KB, width: 2400, height: 2400 })).toMatchObject({ width: UPLOAD_IMAGE_MAX_SIDE, height: UPLOAD_IMAGE_MAX_SIDE, type: 'image/webp' });
  });

  it('nunca amplía ni deja una dimensión a cero en una imagen muy alargada', () => {
    expect(planImageResize({ type: 'image/jpeg', size: 900 * KB, width: 100, height: 100 })).toEqual({ width: 100, height: 100, type: 'image/jpeg', quality: UPLOAD_JPEG_QUALITY });
    expect(planImageResize({ type: 'image/png', size: 100 * KB, width: 16_000, height: 3 })).toMatchObject({ width: UPLOAD_IMAGE_MAX_SIDE, height: 1 });
  });

  it('GIF, SVG, AVIF y cualquier otro tipo no se tocan; tampoco medidas inválidas', () => {
    for (const type of ['image/gif', 'image/svg+xml', 'image/avif', 'application/pdf', '']) {
      expect(planImageResize({ type, size: 9_000 * KB, width: 5000, height: 5000 }), type).toBeNull();
    }
    expect(planImageResize({ type: 'image/jpeg', size: 9_000 * KB, width: 0, height: 100 })).toBeNull();
    expect(planImageResize({ type: 'image/jpeg', size: 9_000 * KB, width: Number.NaN, height: 100 })).toBeNull();
  });
});

describe('isResizableType / fileNameForType', () => {
  it('solo JPEG, PNG y WebP son reducibles', () => {
    expect(['image/jpeg', 'image/png', 'image/webp'].every(isResizableType)).toBe(true);
    expect(isResizableType('image/gif')).toBe(false);
  });

  it('el nombre lleva la extensión del formato nuevo (Blob deduce el tipo de la ruta)', () => {
    expect(fileNameForType('IMG_0001.HEIC.jpeg', 'image/jpeg')).toBe('IMG_0001.HEIC.jpg');
    expect(fileNameForType('logo.png', 'image/webp')).toBe('logo.webp');
    expect(fileNameForType('sin-extension', 'image/png')).toBe('sin-extension.png');
    expect(fileNameForType('.jpg', 'image/jpeg')).toBe('imagen.jpg');
  });
});
