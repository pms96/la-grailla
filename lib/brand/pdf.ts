import { readFile } from 'fs/promises';
import path from 'path';
import { rgb, type PDFDocument, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { absoluteBrandUrl, type Brand } from './brand';
import { hexToRgb } from './theme';

/* Marca en PDFs: el logo del cliente (o su nombre en texto si no tiene) y su color. */

export function pdfColor(hex: string): ReturnType<typeof rgb> {
  const [r, g, b] = hexToRgb(hex);
  return rgb(r / 255, g / 255, b / 255);
}

/** Tope de un logo descargado y de sus dimensiones: un PNG pequeño en bytes puede descomprimirse a gigabytes dentro de pdf-lib. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_DIMENSION = 4096;

/** Lee un fichero de red con tope de bytes (por Content-Length y por lo realmente leído) y sin seguir redirecciones. */
export async function fetchLimited(url: string, maxBytes = MAX_LOGO_BYTES, timeoutMs = 5000): Promise<Uint8Array | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!res.ok) return null;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length > maxBytes ? null : bytes;
}

/** Ancho y alto de un PNG leyendo su cabecera IHDR (sin descomprimir nada). null si no es un PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

async function logoBytes(url: string): Promise<Uint8Array | null> {
  try {
    // Los logos propios de la instalación (/brand/…) se leen de disco (ruta construida con `public/brand` literal para que el trazado de
    // ficheros de Next incluya la carpeta en la función); si no están, se piden por HTTPS al propio dominio. Los de Blob, por HTTPS con tope.
    if (url.startsWith('/brand/')) {
      try {
        return new Uint8Array(await readFile(path.join(process.cwd(), 'public', 'brand', url.slice('/brand/'.length))));
      } catch {
        const abs = absoluteBrandUrl(url);
        return abs?.startsWith('https://') ? await fetchLimited(abs) : null;
      }
    }
    const abs = absoluteBrandUrl(url);
    return abs?.startsWith('https://') ? await fetchLimited(abs) : null;
  } catch (err) {
    console.error('[brand] no se pudo leer el logo para el PDF:', url, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Incrusta el logo del cliente (versión para fondo claro). null si no tiene logo o no se puede leer/no es PNG ni JPEG: el PDF se hace igual, con el nombre en texto. */
export async function embedBrandLogo(pdf: PDFDocument, brand: Brand): Promise<PDFImage | null> {
  const url = brand.logoOnLight ?? brand.logoOnDark;
  if (!url) return null;
  const bytes = await logoBytes(url);
  if (!bytes) return null;
  const png = pngSize(bytes);
  if (png && (png.width > MAX_LOGO_DIMENSION || png.height > MAX_LOGO_DIMENSION)) {
    console.error('[brand] logo demasiado grande para el PDF:', png.width, 'x', png.height);
    return null;
  }
  try {
    return await pdf.embedPng(bytes);
  } catch {
    try {
      return await pdf.embedJpg(bytes);
    } catch {
      return null;
    }
  }
}

/** Nombre de la marca apto para las fuentes estándar de PDF (solo Latin-1: lo demás haría fallar el documento). */
export function pdfBrandName(brand: Brand): string {
  return brand.name.split('').map((c) => (c.charCodeAt(0) <= 255 ? c : '?')).join('');
}

/** Texto de marca (sin logo) en la posición y tamaño dados. Devuelve el ancho que ocupa. */
export function drawBrandWordmark(page: PDFPage, font: PDFFont, brand: Brand, opts: { x: number; y: number; size: number }): number {
  const text = pdfBrandName(brand);
  page.drawText(text, { x: opts.x, y: opts.y, size: opts.size, font, color: pdfColor(brand.colors.emailAccent) });
  return font.widthOfTextAtSize(text, opts.size);
}
