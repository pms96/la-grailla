import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobImgProps, isOptimizableBlobUrl, optimizedBlobHost } from '@/lib/images/blob-image';

/* Envoltura de las imágenes de Blob: solo optimiza el host EXACTO del store de la plataforma y solo si BLOB_PUBLIC_HOST está definida. */

const HOST = 'abc123.public.blob.vercel-storage.com';
const IMG = `https://${HOST}/t1/events/e1/cartel 1.jpg`;
const SIZES = '(min-width:1024px) 33vw, 100vw';

const saved = { host: process.env.BLOB_PUBLIC_HOST, off: process.env.IMAGES_UNOPTIMIZED };
beforeEach(() => {
  delete process.env.BLOB_PUBLIC_HOST;
  delete process.env.IMAGES_UNOPTIMIZED;
});
afterEach(() => {
  if (saved.host === undefined) delete process.env.BLOB_PUBLIC_HOST;
  else process.env.BLOB_PUBLIC_HOST = saved.host;
  if (saved.off === undefined) delete process.env.IMAGES_UNOPTIMIZED;
  else process.env.IMAGES_UNOPTIMIZED = saved.off;
});

const on = () => {
  process.env.BLOB_PUBLIC_HOST = HOST;
};

describe('blobImgProps: optimización activa', () => {
  it('una URL del host exacto genera srcset hacia /_next/image con la URL original codificada y q=75', () => {
    on();
    const p = blobImgProps(IMG, { sizes: SIZES });
    expect(p.sizes).toBe(SIZES);
    expect(p.srcSet).toBeTruthy();
    const encoded = encodeURIComponent(IMG);
    const candidates = p.srcSet!.split(', ');
    expect(candidates.length).toBeGreaterThan(3);
    for (const c of candidates) expect(c).toMatch(new RegExp(`^/_next/image\\?url=${encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}&w=\\d+&q=75 \\d+w$`));
    // la URL original solo aparece codificada (un espacio no puede llegar tal cual al atributo)
    expect(p.srcSet).not.toContain(IMG);
    expect(p.src).toMatch(/^\/_next\/image\?url=.+&w=\d+&q=75$/);
  });

  it('solo devuelve src, srcSet y sizes (no añade width, height, style ni loading al <img>)', () => {
    on();
    expect(Object.keys(blobImgProps(IMG, { sizes: SIZES })).sort()).toEqual(['sizes', 'src', 'srcSet']);
  });

  it('el nombre del host se compara sin distinguir mayúsculas en la variable', () => {
    process.env.BLOB_PUBLIC_HOST = ` ${HOST.toUpperCase()} `;
    expect(optimizedBlobHost()).toBe(HOST);
    expect(blobImgProps(IMG, { sizes: SIZES }).srcSet).toBeTruthy();
  });
});

describe('blobImgProps: sin optimización (se devuelve el src original)', () => {
  it('sin la variable BLOB_PUBLIC_HOST', () => {
    expect(blobImgProps(IMG, { sizes: SIZES })).toEqual({ src: IMG });
  });

  it('con IMAGES_UNOPTIMIZED=1 aunque exista la variable', () => {
    on();
    process.env.IMAGES_UNOPTIMIZED = '1';
    expect(blobImgProps(IMG, { sizes: SIZES })).toEqual({ src: IMG });
  });

  it('IMAGES_UNOPTIMIZED con otro valor no lo desactiva', () => {
    on();
    process.env.IMAGES_UNOPTIMIZED = '0';
    expect(blobImgProps(IMG, { sizes: SIZES }).srcSet).toBeTruthy();
  });

  it('con una variable mal formada (comodín, esquema, ruta, otro dominio) se queda desactivada', () => {
    for (const bad of ['*.public.blob.vercel-storage.com', `https://${HOST}`, `${HOST}/`, 'public.blob.vercel-storage.com', '.public.blob.vercel-storage.com', 'abc123.example.com', 'abc123.public.blob.vercel-storage.com.evil.com']) {
      process.env.BLOB_PUBLIC_HOST = bad;
      expect(optimizedBlobHost(), bad).toBeNull();
      expect(blobImgProps(IMG, { sizes: SIZES }), bad).toEqual({ src: IMG });
    }
  });

  it('otro store de Blob', () => {
    on();
    const other = 'https://zzz999.public.blob.vercel-storage.com/t1/a.jpg';
    expect(blobImgProps(other, { sizes: SIZES })).toEqual({ src: other });
  });

  it('http: (aunque el host coincida)', () => {
    on();
    const http = `http://${HOST}/t1/a.jpg`;
    expect(blobImgProps(http, { sizes: SIZES })).toEqual({ src: http });
  });

  it('subdominios y dominios que solo parecen el host', () => {
    on();
    const tricky = [
      `https://sub.${HOST}/a.jpg`,
      `https://${HOST}.evil.com/a.jpg`,
      `https://evil-${HOST}/a.jpg`,
      `https://evil${HOST}/a.jpg`,
      `https://${HOST}@evil.com/a.jpg`,
      `https://evil.com/${HOST}/a.jpg`,
      `https://evil.com/a.jpg?u=https://${HOST}/a.jpg`,
      `https://${HOST}:8443/a.jpg`,
      `https://user:pass@${HOST}/a.jpg`,
      `https:\\\\${HOST}\\a.jpg`,
      `//${HOST}/a.jpg`,
    ];
    for (const url of tricky) expect(blobImgProps(url, { sizes: SIZES }), url).toEqual({ src: url });
  });

  it('URL con query o fragmento (remotePatterns exige search vacío)', () => {
    on();
    for (const url of [`https://${HOST}/a.jpg?x=1`, `https://${HOST}/a.jpg?`, `https://${HOST}/a.jpg#frag`]) {
      expect(blobImgProps(url, { sizes: SIZES }), url).toEqual({ src: url });
    }
  });

  it('rutas relativas, data:, blob: y valores vacíos', () => {
    on();
    for (const url of ['/brand/logo.png', 'brand/logo.png', 'data:image/png;base64,AAAA', 'blob:https://x.test/uuid', 'javascript:alert(1)', '', 'no es una url']) {
      expect(blobImgProps(url, { sizes: SIZES }), url).toEqual({ src: url });
    }
    expect(blobImgProps(null, { sizes: SIZES })).toEqual({ src: '' });
    expect(blobImgProps(undefined, { sizes: SIZES })).toEqual({ src: '' });
  });
});

describe('isOptimizableBlobUrl', () => {
  it('exige el prefijo https://<host>/ y un parseo limpio', () => {
    expect(isOptimizableBlobUrl(`https://${HOST}/a.jpg`, HOST)).toBe(true);
    expect(isOptimizableBlobUrl(`https://${HOST}`, HOST)).toBe(false);
    expect(isOptimizableBlobUrl(`HTTPS://${HOST}/a.jpg`, HOST)).toBe(false);
    expect(isOptimizableBlobUrl(`https://${HOST.toUpperCase()}/a.jpg`, HOST)).toBe(false);
  });
});
