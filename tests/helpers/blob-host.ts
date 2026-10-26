import { expect } from 'vitest';

/* Ayudas para los tests de render con la optimización de imágenes de Blob activa (lib/images/blob-image.ts). */
export const BLOB_PUBLIC_HOST = 'abc123.public.blob.vercel-storage.com';

/** Ejecuta `fn` con `BLOB_PUBLIC_HOST` definida (o sin definir si `host` es null; y `IMAGES_UNOPTIMIZED` sin definir) y deja el entorno como estaba. */
export function withBlobHost<T>(fn: () => T, host: string | null = BLOB_PUBLIC_HOST): T {
  const saved = { host: process.env.BLOB_PUBLIC_HOST, off: process.env.IMAGES_UNOPTIMIZED };
  if (host === null) delete process.env.BLOB_PUBLIC_HOST;
  else process.env.BLOB_PUBLIC_HOST = host;
  delete process.env.IMAGES_UNOPTIMIZED;
  try {
    return fn();
  } finally {
    if (saved.host === undefined) delete process.env.BLOB_PUBLIC_HOST;
    else process.env.BLOB_PUBLIC_HOST = saved.host;
    if (saved.off === undefined) delete process.env.IMAGES_UNOPTIMIZED;
    else process.env.IMAGES_UNOPTIMIZED = saved.off;
  }
}

/** Valor de un atributo del HTML renderizado (decodifica `&amp;`), o `undefined`. Solo para atributos entre comillas dobles. */
export function attr(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`[\\s<]${name}="([^"]*)"`));
  return m ? m[1]!.replace(/&amp;/g, '&') : undefined;
}

/** Comprueba que `srcset` pide variantes de `/_next/image` de `original` con calidad 75 y la URL original bien codificada. */
export function expectOptimized(html: string, original: string): void {
  const srcset = attr(html, 'srcSet');
  const enc = encodeURIComponent(original);
  expect(typeof srcset).toBe('string');
  for (const candidate of srcset!.split(', ')) {
    const [url, width] = candidate.split(' ');
    expect(url!.startsWith(`/_next/image?url=${enc}&w=`)).toBe(true);
    expect(url).toMatch(/&q=75$/);
    expect(width).toMatch(/^\d+w$/);
  }
  expect(html).not.toContain(`src="${original}"`);
  expect(attr(html, 'sizes')).toMatch(/\S/);
}
