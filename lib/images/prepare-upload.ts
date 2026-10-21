/* Reduce en el NAVEGADOR la imagen que se va a subir desde el panel (ver `resize-plan.ts` para las reglas y el porqué). Solo cliente: usa canvas.
 * Ante cualquier fallo (navegador sin soporte, imagen que no se decodifica, resultado más pesado que el original) devuelve el fichero tal cual:
 * reducir es una mejora, nunca debe impedir una subida que antes funcionaba. */

import { fileNameForType, isResizableType, planImageResize } from '@/lib/images/resize-plan';

export async function prepareImageForUpload(file: File): Promise<File> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined' || !isResizableType(file.type)) return file;
    const bitmap = await createImageBitmap(file);
    const plan = planImageResize({ type: file.type, size: file.size, width: bitmap.width, height: bitmap.height });
    if (!plan) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, plan.type, plan.quality));
    // `toBlob` cae a PNG si el navegador no sabe codificar el formato pedido: en ese caso (o si no adelgaza) se sube el original.
    if (!blob || blob.type !== plan.type || blob.size >= file.size) return file;
    return new File([blob], fileNameForType(file.name, plan.type), { type: plan.type, lastModified: Date.now() });
  } catch {
    return file;
  }
}
