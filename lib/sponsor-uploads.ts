// Tipos/tamaños admitidos para las subidas de sponsors — compartido entre las
// rutas que emiten el token de subida directa a Vercel Blob y las que
// confirman/persisten el resultado, para no duplicar la lista en dos sitios.
export const ALLOWED_SPONSOR_MATERIAL_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
  'video/3gpp',
  'video/x-m4v',
]);
export const MAX_SPONSOR_MATERIAL_SIZE = 50 * 1024 * 1024;

export const ALLOWED_FINAL_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
  'video/3gpp',
  'video/x-m4v',
  'video/mpeg',
]);
export const MAX_FINAL_VIDEO_SIZE = 200 * 1024 * 1024;
