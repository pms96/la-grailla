/* Reglas del vídeo de cabecera de la plantilla «cine». Módulo puro (sin servidor ni React): lo usan la ruta que emite el token de subida, el campo
 * del panel y los tests.
 *
 * El vídeo se sube DIRECTAMENTE del navegador a Vercel Blob (el binario no pasa por una función serverless, que tiene un límite de ~4,5 MB). El
 * servidor solo decide si ese navegador puede subir ESA ruta, con ESE tipo y hasta ESE tamaño: la ruta lleva siempre el prefijo del cliente. */

export const HERO_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
/** Un vídeo de cabecera tiene que ser ligero: se descarga en segundo plano en la portada. */
export const HERO_VIDEO_MAX_BYTES = 40 * 1024 * 1024;

/** Carpeta de Blob donde va el vídeo de cabecera de un cliente (`tenantPrefix` es `{tenantId}/` en modo plataforma y vacío en instalación única). */
export function heroVideoBlobPrefix(tenantPrefix: string): string {
  return `${tenantPrefix}brand/hero/`;
}

/** ¿Puede el navegador subir un fichero a esta ruta? Dentro de la carpeta del cliente, sin saltos de carpeta y solo MP4 o WebM. */
export function isHeroVideoPath(pathname: string, tenantPrefix: string): boolean {
  if (!pathname.startsWith(heroVideoBlobPrefix(tenantPrefix))) return false;
  if (pathname.split('/').includes('..')) return false;
  return /\.(mp4|webm)$/i.test(pathname);
}

/** Motivo por el que un fichero elegido en el panel no sirve, o null si vale. */
export function heroVideoFileProblem(file: { type: string; size: number }): string | null {
  if (!(HERO_VIDEO_TYPES as readonly string[]).includes(file.type)) return 'El vídeo debe ser MP4 o WebM.';
  if (file.size > HERO_VIDEO_MAX_BYTES) return `El vídeo pesa demasiado (máximo ${HERO_VIDEO_MAX_BYTES / 1024 / 1024} MB). Comprímelo o acórtalo.`;
  return null;
}
