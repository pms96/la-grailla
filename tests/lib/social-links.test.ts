import { describe, it, expect } from 'vitest';
import { safeHttpUrl, socialLinks } from '@/lib/social-links';

/* P1-18 / MO-09: las redes de Configuración se pintan en el pie, solo como enlaces http(s) seguros. */

describe('safeHttpUrl', () => {
  it('acepta http(s) y asume https si falta el esquema', () => {
    expect(safeHttpUrl('https://instagram.com/cuenta')).toBe('https://instagram.com/cuenta');
    expect(safeHttpUrl('http://example.com/x')).toBe('http://example.com/x');
    expect(safeHttpUrl('instagram.com/cuenta')).toBe('https://instagram.com/cuenta');
    expect(safeHttpUrl('  https://tiktok.com/@cuenta  ')).toBe('https://tiktok.com/@cuenta');
  });

  it('rechaza lo vacío, lo que no es http(s) y lo que no es una dirección', () => {
    for (const v of ['', '   ', undefined, null, 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'mailto:a@b.c', 'ftp://x.com', 'https://']) {
      expect(safeHttpUrl(v as string | undefined), String(v)).toBeNull();
    }
  });
});

describe('socialLinks', () => {
  it('devuelve solo las redes rellenadas y válidas, en orden fijo', () => {
    const links = socialLinks({ social_facebook: 'facebook.com/x', social_instagram: 'https://instagram.com/y', social_tiktok: '', social_twitter: 'javascript:alert(1)' });
    expect(links).toEqual([
      { label: 'Instagram', href: 'https://instagram.com/y' },
      { label: 'Facebook', href: 'https://facebook.com/x' },
    ]);
  });

  it('sin ninguna red no devuelve nada', () => {
    expect(socialLinks({})).toEqual([]);
  });
});
