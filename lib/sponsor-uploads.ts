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

/* Rutas de Blob de un sponsor. En modo plataforma el almacén es compartido y cada cliente sube bajo `{tenantId}/`: el prefijo lo pone el
 * servidor (tenantBlobPrefix) y el navegador lo recibe en el contexto de marca (`useBrand().blobPrefix`); aquí se exige que la ruta que
 * elige el navegador lo lleve, para que un archivo de un cliente nunca quede en la carpeta de otro. En una instalación única el prefijo
 * es vacío y las rutas son las de siempre (`sponsors/{id}/…`). */
export const sponsorBlobPrefix = (prefix: string, sponsorId: string) => `${prefix}sponsors/${sponsorId}/`;
export const sponsorFinalVideoBlobPrefix = (prefix: string, sponsorId: string) => `${prefix}sponsors/${sponsorId}/final-video/`;
