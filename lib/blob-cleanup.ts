import { del } from '@vercel/blob';
import { prisma } from '@/lib/prisma';
import { isBlobUrlUnder, parseBlobUrl } from '@/lib/blob-url';
import { tenantBlobPrefix } from '@/lib/tenant/blob';

/* Limpieza de ficheros de Vercel Blob que el cliente ya no usa. Al cambiar un logo, un vídeo de cabecera, el cartel de un evento o la foto de un
 * producto, el fichero anterior se quedaba en Blob para siempre (se paga por almacenamiento y, en modo plataforma, se acumula por cliente).
 *
 * Reglas, pensadas para que borrar de más sea imposible:
 *   1. Solo se consideran los ficheros que ESTABAN y YA NO están (antes − después).
 *   2. Solo URLs de Blob y, en modo plataforma, solo las del prefijo de ESTE cliente (nunca el fichero de otro).
 *   3. Se borra después de guardar en la BD, y solo si NADA más lo usa (tema, secciones, eventos, productos).
 *   4. Un fallo al borrar nunca rompe el guardado: el fichero queda huérfano, como antes, y se avisa en el log. */

type Ref = string | null | undefined;

/** Ficheros que estaban en `before` y ya no están en `after`, filtrados a los que este cliente puede borrar. Puro (el prefijo se pasa de fuera). */
export function removedBlobUrls(before: readonly Ref[], after: readonly Ref[], tenantPrefix: string): string[] {
  const keep = new Set(after.filter((u): u is string => typeof u === 'string' && u !== ''));
  const prefix = tenantPrefix.replace(/\/+$/, '');
  const out = new Set<string>();
  for (const url of before) {
    if (typeof url !== 'string' || url === '' || keep.has(url)) continue;
    if (!parseBlobUrl(url)) continue;
    if (prefix !== '' && !isBlobUrlUnder(url, prefix)) continue;
    out.add(url);
  }
  return [...out];
}

/** ¿Sigue algo usando este fichero? Mira donde puede haber URLs de Blob del cliente: configuración (tema y secciones), eventos y productos. */
async function isInUse(url: string): Promise<boolean> {
  const found = await Promise.all([
    prisma.appConfig.findFirst({ where: { value: { contains: url } }, select: { id: true } }),
    prisma.event.findFirst({ where: { imageUrl: url }, select: { id: true } }),
    prisma.product.findFirst({ where: { OR: [{ imageUrl: url }, { images: { has: url } }] }, select: { id: true } }),
    // El resto de sitios donde la aplicación guarda una URL de Blob: aunque estas rutas no se puedan alcanzar desde el panel con una URL ajena,
    // borrar un fichero que otra cosa usa es lo único irreversible, así que se mira todo.
    prisma.sponsorAsset.findFirst({ where: { url }, select: { id: true } }),
    prisma.sponsor.findFirst({ where: { finalVideoUrl: url }, select: { id: true } }),
    prisma.order.findFirst({ where: { pdfUrl: url }, select: { id: true } }),
    prisma.user.findFirst({ where: { image: url }, select: { id: true } }),
  ]);
  return found.some(Boolean);
}

/**
 * Borra de Blob los ficheros que dejan de usarse tras un cambio ya guardado. No lanza nunca. Devuelve los borrados (para los tests).
 * `before` = referencias antes del cambio; `after` = referencias que quedan.
 */
export async function releaseUnusedBlobs(before: readonly Ref[], after: readonly Ref[]): Promise<string[]> {
  try {
    const candidates = removedBlobUrls(before, after, tenantBlobPrefix());
    if (candidates.length === 0) return [];
    const unused: string[] = [];
    for (const url of candidates) {
      if (!(await isInUse(url))) unused.push(url);
    }
    if (unused.length === 0) return [];
    await del(unused);
    return unused;
  } catch (error) {
    console.warn('[blob-cleanup] No se pudieron borrar ficheros que ya no se usan:', error instanceof Error ? error.message : error);
    return [];
  }
}
