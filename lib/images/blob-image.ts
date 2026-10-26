/* Optimización de las imágenes que suben los clientes a Vercel Blob.
 *
 * Los `<img>` del sitio público siguen siendo `<img>` (mismas clases, mismo maquetado: el CSS de las plantillas los estiliza por selector).
 * `blobImgProps(url, { sizes })` solo añade `srcset` y `sizes` apuntando al optimizador de Next (`/_next/image`) cuando se cumplen TODAS estas
 * condiciones; si falla cualquiera, devuelve `{ src: url }` tal cual, que es lo que había antes:
 *
 *  1. Existe la variable NO secreta `BLOB_PUBLIC_HOST` con el hostname exacto del store de Blob de la plataforma
 *     (`<id>.public.blob.vercel-storage.com`) y `IMAGES_UNOPTIMIZED` no vale `1`. Sin la variable, `next.config.js` deja `images.unoptimized`.
 *  2. La URL es https, su hostname es EXACTAMENTE ese host (ni otro store de Blob, ni subdominios, ni `host.evil.com`), sin puerto, sin
 *     credenciales, sin query y sin fragmento. Es lo mismo que admite `images.remotePatterns` en la configuración, así que en producción el
 *     optimizador nunca recibe una URL que vaya a rechazar (400) y en desarrollo `next/image` no lanza.
 *
 * `next.config.js` expone las dos variables al código con `env` (valor fijado en el build): servidor y navegador deciden igual.
 * No se usa `<Image>` ni `fill`: `getImageProps` solo calcula los atributos y aquí se descartan `style`, `width`, `height` y `loading`. */
import { getImageProps } from 'next/image';

/** Hostname de un store de Blob (id en minúsculas). Se repite en next.config.js: ese fichero es CommonJS y no puede importar TypeScript. */
const BLOB_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.public\.blob\.vercel-storage\.com$/;

/** Calidad única (coincide con `images.qualities` de next.config.js). */
const QUALITY = 75;

export type BlobImgProps = { src: string; srcSet?: string; sizes?: string };

/** Hostname del store si la optimización está activa, o `null`. Las lecturas de `process.env.X` son literales a propósito: Next las sustituye en el build. */
export function optimizedBlobHost(): string | null {
  const host = (process.env.BLOB_PUBLIC_HOST ?? '').trim().toLowerCase();
  if (!host || !BLOB_HOST_RE.test(host)) return null;
  if (process.env.IMAGES_UNOPTIMIZED === '1') return null;
  return host;
}

/** ¿Es una URL que el optimizador puede (y debe) servir? Solo https, host exacto, sin puerto, credenciales, query ni fragmento. */
export function isOptimizableBlobUrl(url: string, host: string): boolean {
  // `?` y `#` se miran en el texto: `new URL('…a.jpg?').search` es '' aunque el signo esté.
  if (!url.startsWith(`https://${host}/`) || url.includes('?') || url.includes('#')) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname === host && parsed.port === '' && !parsed.username && !parsed.password && parsed.search === '' && parsed.hash === '';
}

/**
 * Atributos `src`, `srcSet` y `sizes` para un `<img>` de usuario: `<img {...blobImgProps(url, { sizes })} alt="" className="…" />`.
 * `sizes` es el ancho que ocupa la imagen en la página (como el atributo HTML): del acierto depende qué variante descarga el navegador.
 */
export function blobImgProps(url: string | null | undefined, { sizes }: { sizes: string }): BlobImgProps {
  const src = url ?? '';
  const host = optimizedBlobHost();
  if (!host || !isOptimizableBlobUrl(src, host)) return { src };
  const { props } = getImageProps({ src, alt: '', fill: true, sizes, quality: QUALITY });
  // Sin srcSet no hay optimización (p. ej. configuración `unoptimized`): se deja el src original.
  if (!props.srcSet) return { src };
  // `src` va el último: React aplica los atributos en orden y Safari empezaría a descargarlo antes de conocer `srcset` y `sizes`.
  return { sizes: props.sizes, srcSet: props.srcSet, src: props.src };
}

/** `sizes` según el espacio que ocupa la imagen. Los vw de abajo coinciden con el CSS de cada maquetación (ver comentarios). */
export const IMG_SIZES = {
  /** Fondo a todo el ancho de la ventana (héroes con la imagen detrás del texto). */
  full: '100vw',
  /** Rejilla de 1 / 2 / 3 columnas (md y lg) dentro de un contenedor de 1200 px: tarjetas de evento y de producto. */
  grid3: '(min-width:1232px) 384px, (min-width:1024px) 33vw, (min-width:768px) 50vw, 100vw',
  /** Rejilla de 1 / 2 / 3 columnas con cambio en `sm` y `lg` (secciones «proyectos» y similares). */
  grid3Sm: '(min-width:1024px) 33vw, (min-width:640px) 50vw, 100vw',
  /** Rejilla de 2 / 3 / 4 columnas (plantillas Cine y Drop, contenedor de 1400-1600 px). */
  grid4: '(min-width:1680px) 368px, (min-width:1024px) 25vw, (min-width:768px) 33vw, 50vw',
  /** Rejilla de 2 columnas que pasa a 4 en lg (sección «equipo»). */
  grid4Lg: '(min-width:1024px) 25vw, 50vw',
  /** Riel horizontal de Cine: `.cn-rail-item` mide clamp(13.5rem, 60vw, 19rem). */
  railCine: '(min-width:507px) 304px, 60vw',
  /** Riel de Drop: `.dp-rail-item` mide clamp(12.5rem, 56vw, 17rem). */
  railDrop: '(min-width:486px) 272px, 56vw',
  /** Cartel de ficha o de banner en una columna de 4/12 desde md (a todo el ancho en móvil). */
  poster4: '(min-width:1280px) 384px, (min-width:768px) 33vw, 100vw',
  /** Cartel del banner de Cine: 5/12 desde md y 4/12 desde lg, en un contenedor de 1600 px. */
  posterCine: '(min-width:1680px) 480px, (min-width:1024px) 33vw, (min-width:768px) 42vw, 100vw',
  /** Cartel en una columna de 5/12 desde md. */
  poster5: '(min-width:1232px) 480px, (min-width:768px) 42vw, 100vw',
  /** Cartel en una columna de 6/12 desde md. */
  poster6: '(min-width:1400px) 640px, (min-width:768px) 50vw, 100vw',
  /** Imagen principal de una tarjeta de 3/5 de la rejilla (evento destacado en /eventos). */
  feature3of5: '(min-width:1152px) 690px, (min-width:768px) 60vw, 100vw',
  /** Ficha de producto de Drop: tira de imágenes en 7/12 al 86 %. */
  productStrip: '(min-width:1400px) 600px, (min-width:768px) 50vw, 100vw',
  /** Carrusel dentro del diálogo de producto (máx. 28 rem). */
  dialog: '(min-width:640px) 448px, 100vw',
  /** Miniatura de 56 px (h-14 w-14), con margen para pantallas de 2x y 3x. */
  thumb: '96px',
  /** Vista previa que sigue al cursor en Marquesina: `min(22vw, 20rem)`. */
  marquesinaPreview: '(min-width:1455px) 320px, 22vw',
  /** Vista previa que sigue al cursor en Estudio: 22 rem. */
  estudioPreview: '352px',
} as const;
