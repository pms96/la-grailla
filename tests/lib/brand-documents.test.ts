import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { brandLogoHtml } from '@/lib/brand/email';
import { resolveBrand, neutralTheme } from '@/lib/brand/brand';
import { MAX_LOGO_DIMENSION, embedBrandLogo, fetchLimited, pdfBrandName, pngSize } from '@/lib/brand/pdf';

/* Marca en emails y PDFs: escape, sin logo, y límites de lo que se descarga. */

const brand = (name: string, assets: Record<string, string> = {}) => resolveBrand({ ...neutralTheme(name), assets }, false, '', 'x.es');

// PNG mínimo válido (1×1) y una cabecera que DICE ser enorme.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function hugePng(): Uint8Array {
  const b = Buffer.from(PNG_1X1);
  b.writeUInt32BE(MAX_LOGO_DIMENSION + 1, 16);
  b.writeUInt32BE(10, 20);
  return new Uint8Array(b);
}

describe('brandLogoHtml', () => {
  it('sin logo: el nombre escapado, en el color de marca', () => {
    const html = brandLogoHtml(brand('<b>Sala</b> & "Co"'), undefined, 32);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;Sala&lt;/b&gt; &amp; "Co"');
  });
  it('con logo: las comillas del nombre y de la URL no pueden salir del atributo', () => {
    const html = brandLogoHtml(brand('Sala" onerror="alert(1)', { logoOnLight: 'https://s.public.blob.vercel-storage.com/t/brand/logo.png' }), undefined, 32);
    expect(html).toContain('alt="Sala&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain('alt="Sala" onerror');
  });
});

describe('PDF', () => {
  it('el nombre de marca se reduce a Latin-1 (lo demás haría fallar el documento)', () => {
    expect(pdfBrandName(brand('Sala Ñoño 日本'))).toBe('Sala Ñoño ??');
  });
  it('lee las dimensiones del PNG sin descomprimirlo', () => {
    expect(pngSize(new Uint8Array(PNG_1X1))).toEqual({ width: 1, height: 1 });
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it('un logo con dimensiones desorbitadas no se incrusta (bomba de descompresión)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(hugePng())));
    try {
      const pdf = await PDFDocument.create();
      const b = brand('X', { logoOnLight: 'https://s.public.blob.vercel-storage.com/t/brand/logo.png' });
      expect(await embedBrandLogo(pdf, b)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('un logo normal se incrusta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(PNG_1X1))));
    try {
      const pdf = await PDFDocument.create();
      const b = brand('X', { logoOnLight: 'https://s.public.blob.vercel-storage.com/t/brand/logo.png' });
      expect(await embedBrandLogo(pdf, b)).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('fetchLimited rechaza lo que declara o trae más bytes que el tope, y los errores HTTP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(100), { headers: { 'content-length': '999999999' } })));
    expect(await fetchLimited('https://x.public.blob.vercel-storage.com/a.png', 1000)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(5000))));
    expect(await fetchLimited('https://x.public.blob.vercel-storage.com/a.png', 1000)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));
    expect(await fetchLimited('https://x.public.blob.vercel-storage.com/a.png')).toBeNull();
    vi.unstubAllGlobals();
  });
});
