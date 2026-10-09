import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

/* Hasta ahora solo se probaba la función pura de Origin: nadie ejecutaba el middleware del panel. */

const req = (method: string, headers: Record<string, string> = {}) =>
  new NextRequest('https://panel.example/tenants', { method, headers: { host: 'panel.example', ...headers } });

afterEach(() => vi.unstubAllEnvs());

describe('middleware del panel', () => {
  it('un POST de otro origen recibe 403', () => {
    const res = middleware(req('POST', { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('x-middleware-next')).toBeNull();
  });

  it('un POST del mismo origen y una lectura de otro origen pasan', () => {
    expect(middleware(req('POST', { origin: 'https://panel.example' })).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(req('GET', { origin: 'https://evil.example' })).headers.get('x-middleware-next')).toBe('1');
  });

  it('una vista previa de Vercel no sirve nada: 404 aunque la petición sea válida', () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const res = middleware(req('GET'));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-middleware-next')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('producción y desarrollo sí sirven', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(middleware(req('GET')).headers.get('x-middleware-next')).toBe('1');
  });
});
