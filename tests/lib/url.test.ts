import { describe, it, expect, afterEach } from 'vitest';
import { getBaseUrl, getFallbackBaseUrl, isValidHost } from '@/lib/url';

const originalUrl = process.env.NEXTAUTH_URL;
afterEach(() => {
  if (originalUrl === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = originalUrl;
});

function req(headers: Record<string, string>): Request {
  return new Request('http://internal/x', { headers });
}

describe('isValidHost', () => {
  it.each(['www.lagrailla.es', 'localhost:3000', '127.0.0.1:57810', 'mi-tienda.vercel.app'])('acepta %s', (h) => {
    expect(isValidHost(h)).toBe(true);
  });

  it.each(['evil.com/path', 'user@evil.com', 'a b.com', 'evil.com\r\nX: 1', '', '.evil.com', 'evil.com:99999999'])(
    'rechaza %j',
    (h) => {
      expect(isValidHost(h)).toBe(false);
    }
  );
});

describe('getFallbackBaseUrl', () => {
  it('quita la barra final y devuelve vacío si no hay valor', () => {
    process.env.NEXTAUTH_URL = 'https://www.lagrailla.es/';
    expect(getFallbackBaseUrl()).toBe('https://www.lagrailla.es');
    delete process.env.NEXTAUTH_URL;
    expect(getFallbackBaseUrl()).toBe('');
  });
});

describe('getBaseUrl', () => {
  it('usa x-forwarded-host y x-forwarded-proto cuando vienen del proxy', () => {
    expect(getBaseUrl(req({ 'x-forwarded-host': 'www.lagrailla.es', 'x-forwarded-proto': 'https' }))).toBe(
      'https://www.lagrailla.es'
    );
  });

  it('cae al header host y deduce http para localhost', () => {
    expect(getBaseUrl(req({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
    expect(getBaseUrl(req({ host: 'www.lagrailla.es' }))).toBe('https://www.lagrailla.es');
  });

  it('toma el primer valor si el proxy encadena varios', () => {
    expect(getBaseUrl(req({ 'x-forwarded-host': 'www.lagrailla.es, internal.local', 'x-forwarded-proto': 'https, http' }))).toBe(
      'https://www.lagrailla.es'
    );
  });

  it('ignora un protocolo que no sea http/https', () => {
    expect(getBaseUrl(req({ host: 'www.lagrailla.es', 'x-forwarded-proto': 'javascript' }))).toBe('https://www.lagrailla.es');
  });

  it('descarta un host con inyección y usa el valor fijo', () => {
    process.env.NEXTAUTH_URL = 'https://www.lagrailla.es';
    expect(getBaseUrl(req({ 'x-forwarded-host': 'evil.com/phish?', 'x-forwarded-proto': 'https' }))).toBe('https://www.lagrailla.es');
    expect(getBaseUrl(req({ 'x-forwarded-host': 'user@evil.com' }))).toBe('https://www.lagrailla.es');
  });

  it('sin host usa el valor fijo', () => {
    process.env.NEXTAUTH_URL = 'https://www.lagrailla.es/';
    const r = new Request('http://internal/x');
    r.headers.delete('host');
    expect(getBaseUrl(r)).toBe('https://www.lagrailla.es');
  });
});
