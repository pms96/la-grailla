/* Decide, SIN tocar el navegador, si una imagen que se sube desde el panel hay que reducir antes de enviarla y a qué tamaño. Las imágenes de
 * Vercel Blob se sirven tal cual se suben (la web no las optimiza: `images.unoptimized`), así que una foto de móvil de 4000 px y 4 MB llegaría
 * entera a cada visitante. Reducirla al subirla es lo que de verdad pesa en la carga de la portada. Lo usa `prepare-upload.ts` y los tests. */

/** Lado mayor máximo: sobra para una pantalla de 1440 px con densidad 1 y para una ficha a pantalla completa en móvil. */
export const UPLOAD_IMAGE_MAX_SIDE = 1600;
/** Calidad con la que se vuelve a codificar un JPEG: sin diferencia visible a ojo y 4-8 veces menos peso que el original de cámara. */
export const UPLOAD_JPEG_QUALITY = 0.82;
export const UPLOAD_WEBP_QUALITY = 0.85;
/** Un JPEG que cabe en 1600 px solo se recodifica si pesa más que esto (fotos a poca resolución pero con calidad máxima). */
export const UPLOAD_JPEG_HEAVY_BYTES = 700 * 1024;

export type UploadImageType = 'image/jpeg' | 'image/png' | 'image/webp';
export type ResizePlan = { width: number; height: number; type: UploadImageType; quality: number | undefined };

const EXTENSION: Record<UploadImageType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function isResizableType(type: string): type is UploadImageType {
  return type === 'image/jpeg' || type === 'image/png' || type === 'image/webp';
}

/**
 * `null` = se sube tal cual. Reglas:
 * - JPEG: se reduce si excede el lado máximo, o se recodifica si pesa demasiado.
 * - PNG y WebP (logos, con transparencia): SOLO si exceden el lado máximo, y se mantiene el formato para no perder el canal alfa.
 * - Cualquier otro tipo (GIF animado, SVG, AVIF…): sin tocar.
 */
export function planImageResize(input: { type: string; size: number; width: number; height: number }): ResizePlan | null {
  const { type, size, width, height } = input;
  if (!isResizableType(type)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const scale = Math.min(1, UPLOAD_IMAGE_MAX_SIDE / Math.max(width, height));
  const reduced = scale < 1;
  const target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };

  if (type === 'image/jpeg') {
    if (!reduced && size <= UPLOAD_JPEG_HEAVY_BYTES) return null;
    return { ...target, type, quality: UPLOAD_JPEG_QUALITY };
  }
  if (!reduced) return null;
  return { ...target, type, quality: type === 'image/webp' ? UPLOAD_WEBP_QUALITY : undefined };
}

/** El nombre con la extensión del formato nuevo (Blob deduce el tipo de contenido de la ruta, no del fichero). */
export function fileNameForType(name: string, type: UploadImageType): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'imagen';
  return `${base}.${EXTENSION[type]}`;
}
