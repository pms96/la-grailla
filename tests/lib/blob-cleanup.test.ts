import { describe, expect, it } from 'vitest';
import { removedBlobUrls } from '@/lib/blob-cleanup';
import { sectionImageUrls } from '@/lib/content/sections';

const HOST = 'https://abc123.public.blob.vercel-storage.com';
const A = `${HOST}/t1/brand/logo-a.png`;
const B = `${HOST}/t1/brand/logo-b.png`;

describe('removedBlobUrls', () => {
  it('devuelve solo lo que estaba y ya no está', () => {
    expect(removedBlobUrls([A, B], [B], 't1/')).toEqual([A]);
    expect(removedBlobUrls([A], [A], 't1/')).toEqual([]);
    expect(removedBlobUrls([A, B], [], 't1/')).toEqual([A, B]);
    expect(removedBlobUrls([], [A], 't1/')).toEqual([]);
  });

  it('sin repetidos, e ignora vacíos, null y undefined', () => {
    expect(removedBlobUrls([A, A, '', null, undefined], [], 't1/')).toEqual([A]);
    expect(removedBlobUrls([A], [null, undefined, ''], 't1/')).toEqual([A]);
  });

  it('solo URLs de Blob: una ruta local, otro sitio o un valor raro nunca se borran', () => {
    const before = ['/brand/logo-white.png', 'https://otro-sitio.com/a.png', 'javascript:alert(1)', 'no es una url', `${HOST}/t1/a.png?x=1`];
    expect(removedBlobUrls(before, [], '')).toEqual([]);
  });

  it('en modo plataforma solo las del prefijo de ESTE cliente; el fichero de otro cliente no se toca', () => {
    const mine = `${HOST}/t1/brand/mio.png`;
    const theirs = `${HOST}/t2/brand/suyo.png`;
    expect(removedBlobUrls([mine, theirs], [], 't1/')).toEqual([mine]);
    expect(removedBlobUrls([mine, theirs], [], 't1')).toEqual([mine]); // con o sin barra final
    // Un prefijo que solo se parece no vale: «t1» no es «t10».
    expect(removedBlobUrls([`${HOST}/t10/brand/x.png`], [], 't1/')).toEqual([]);
    // Ni saltos de carpeta.
    expect(removedBlobUrls([`${HOST}/t1/../t2/brand/x.png`], [], 't1/')).toEqual([]);
  });

  it('instalación única (sin prefijo): cualquier Blob de la instalación', () => {
    expect(removedBlobUrls([A, `${HOST}/uploads/foto.jpg`], [], '')).toEqual([A, `${HOST}/uploads/foto.jpg`]);
  });
});

describe('sectionImageUrls', () => {
  const item = (imageUrl: string) => ({ title: 'x', text: '', meta: '', imageUrl, href: '' });

  it('las imágenes de una sección guardada, sin las vacías', () => {
    const raw = JSON.stringify({ title: 'Proyectos', intro: '', items: [item(A), item(''), item(B)] });
    expect(sectionImageUrls(raw, 'proyectos')).toEqual([A, B]);
  });

  it('una sección vacía, ausente o corrupta no tiene imágenes', () => {
    expect(sectionImageUrls('', 'proyectos')).toEqual([]);
    expect(sectionImageUrls(null, 'proyectos')).toEqual([]);
    expect(sectionImageUrls('{no es json', 'proyectos')).toEqual([]);
  });

  it('solo se cuentan imágenes de Blob (lo demás ya lo descarta el parser de secciones)', () => {
    const raw = JSON.stringify({ title: '', intro: '', items: [item('https://otro-sitio.com/a.png'), item(A)] });
    expect(sectionImageUrls(raw, 'proyectos')).toEqual([A]);
  });
});
