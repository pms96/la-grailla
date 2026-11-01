import { describe, expect, it } from 'vitest';
import { normalizePublicUrl } from '@/lib/safe-url';

/* H-105: `website` del formulario de sponsors era texto libre y acababa en el `href` de un correo al operador. */

describe('normalizePublicUrl', () => {
  it('acepta http(s) y completa «https://» cuando falta', () => {
    expect(normalizePublicUrl('https://tuempresa.com')).toBe('https://tuempresa.com/');
    expect(normalizePublicUrl('http://tuempresa.com/a?b=1')).toBe('http://tuempresa.com/a?b=1');
    expect(normalizePublicUrl('tuempresa.com')).toBe('https://tuempresa.com/');
    expect(normalizePublicUrl('instagram.com/tuempresa')).toBe('https://instagram.com/tuempresa');
    expect(normalizePublicUrl('  tuempresa.com:8080/x  ')).toBe('https://tuempresa.com:8080/x');
  });

  it('rechaza cualquier esquema que no sea http(s)', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'mailto:a@b.es', 'ftp://x.es', 'vbscript:x']) {
      expect(normalizePublicUrl(bad), bad).toBeNull();
    }
  });

  it('rechaza comillas, espacios, ángulos, comillas invertidas y barras invertidas (no hay forma de salir de un atributo)', () => {
    for (const bad of ['https://x.es" onclick="y', "https://x.es' onclick='y", 'https://x.es/<b>', 'https://x.es/a b', 'https://x.es/`x`', 'https://x.es\\@evil.com']) {
      expect(normalizePublicUrl(bad), bad).toBeNull();
    }
  });

  it('rechaza usuario y contraseña en la URL (https://banco.com@evil.es engaña a quien lee el enlace)', () => {
    expect(normalizePublicUrl('https://banco.com@evil.es')).toBeNull();
    expect(normalizePublicUrl('https://user:pass@evil.es')).toBeNull();
  });

  it('rechaza hosts sin punto (localhost, intranet) y texto sin sentido', () => {
    for (const bad of ['localhost', 'http://intranet/x', '', '   ', 'hola', 'https://']) expect(normalizePublicUrl(bad), bad).toBeNull();
  });

  it('rechaza lo demasiado largo', () => {
    expect(normalizePublicUrl(`https://x.es/${'a'.repeat(300)}`)).toBeNull();
  });
});
