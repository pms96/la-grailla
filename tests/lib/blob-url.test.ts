import { describe, it, expect } from 'vitest';
import { isBlobUrlUnder, isDeletableBlobUrl, parseBlobUrl, sanitizeUploadFileName } from '@/lib/blob-url';

const HOST = 'https://abc123.public.blob.vercel-storage.com';

describe('parseBlobUrl', () => {
  it('acepta una URL https de un store de Vercel Blob', () => {
    expect(parseBlobUrl(`${HOST}/sponsors/s1/logo.png`)?.hostname).toBe('abc123.public.blob.vercel-storage.com');
  });

  it.each([
    ['otro host', 'https://evil.example.com/sponsors/s1/logo.png'],
    ['sufijo engañoso', 'https://public.blob.vercel-storage.com.evil.com/sponsors/s1/logo.png'],
    ['sin subdominio de store', 'https://.public.blob.vercel-storage.com/x'],
    ['http', 'http://abc123.public.blob.vercel-storage.com/sponsors/s1/logo.png'],
    ['con query', `${HOST}/x/logo.png?next=/sponsors/s1/`],
    ['con credenciales', 'https://user:pass@abc123.public.blob.vercel-storage.com/x'],
    ['con puerto', 'https://abc123.public.blob.vercel-storage.com:8443/x'],
    ['no es una URL', 'sponsors/s1/logo.png'],
  ])('rechaza %s', (_label, url) => {
    expect(parseBlobUrl(url)).toBeNull();
  });
});

describe('isBlobUrlUnder', () => {
  it('acepta una URL bajo el prefijo esperado', () => {
    expect(isBlobUrlUnder(`${HOST}/sponsors/s1/logo.png`, 'sponsors/s1/')).toBe(true);
    expect(isBlobUrlUnder(`${HOST}/sponsors/s1/final-video/v.mp4`, 'sponsors/s1/final-video/')).toBe(true);
  });

  it('rechaza el prefijo de otro sponsor o un prefijo parcial', () => {
    expect(isBlobUrlUnder(`${HOST}/sponsors/s2/logo.png`, 'sponsors/s1/')).toBe(false);
    expect(isBlobUrlUnder(`${HOST}/sponsors/s10/logo.png`, 'sponsors/s1/')).toBe(false);
  });

  it('rechaza la subcadena escondida en otro sitio (host, query o ruta distinta)', () => {
    expect(isBlobUrlUnder('https://evil.example.com/sponsors/s1/logo.png', 'sponsors/s1/')).toBe(false);
    expect(isBlobUrlUnder(`${HOST}/otra/ruta.png?x=/sponsors/s1/`, 'sponsors/s1/')).toBe(false);
    expect(isBlobUrlUnder(`${HOST}/otra/sponsors/s1/logo.png`, 'sponsors/s1/')).toBe(false);
  });

  it('rechaza el salto de directorio', () => {
    expect(isBlobUrlUnder(`${HOST}/sponsors/s1/../s2/logo.png`, 'sponsors/s1/')).toBe(false);
    expect(isBlobUrlUnder(`${HOST}/sponsors/s1/%2e%2e/s2/logo.png`, 'sponsors/s1/')).toBe(false);
  });
});

describe('isDeletableBlobUrl', () => {
  it('solo permite borrar URLs de Blob', () => {
    expect(isDeletableBlobUrl(`${HOST}/sponsors/s1/logo.png`)).toBe(true);
    expect(isDeletableBlobUrl('https://evil.example.com/logo.png')).toBe(false);
    expect(isDeletableBlobUrl(null)).toBe(false);
    expect(isDeletableBlobUrl(undefined)).toBe(false);
  });
});

describe('sanitizeUploadFileName', () => {
  it('quita rutas y caracteres raros', () => {
    expect(sanitizeUploadFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadFileName('mi logo (final).png')).toBe('mi_logo_final_.png');
    expect(sanitizeUploadFileName('.htaccess')).toBe('htaccess');
  });

  it('acota la longitud y no devuelve vacío', () => {
    expect(sanitizeUploadFileName('a'.repeat(300) + '.png').length).toBeLessThanOrEqual(100);
    expect(sanitizeUploadFileName('///')).toBe('archivo');
  });
});
