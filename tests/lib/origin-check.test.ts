import { describe, it, expect } from 'vitest';
import { isCrossOriginMutation, isOriginCheckExempt } from '@/lib/origin-check';

function h(headers: Record<string, string>): Headers {
  return new Headers(headers);
}

describe('isCrossOriginMutation', () => {
  it('no mira las lecturas', () => {
    expect(isCrossOriginMutation('GET', h({ origin: 'https://evil.com', host: 'www.lagrailla.es' }))).toBe(false);
    expect(isCrossOriginMutation('HEAD', h({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('bloquea %s desde otro origen', (method) => {
    expect(isCrossOriginMutation(method, h({ origin: 'https://evil.com', host: 'www.lagrailla.es' }))).toBe(true);
  });

  it('deja pasar el mismo origen, también detrás de proxy', () => {
    expect(isCrossOriginMutation('POST', h({ origin: 'https://www.lagrailla.es', host: 'www.lagrailla.es' }))).toBe(false);
    expect(
      isCrossOriginMutation('POST', h({ origin: 'https://www.lagrailla.es', host: 'internal:3000', 'x-forwarded-host': 'www.lagrailla.es' }))
    ).toBe(false);
    expect(isCrossOriginMutation('POST', h({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(false);
  });

  it('bloquea el mismo dominio con otro puerto o subdominio', () => {
    expect(isCrossOriginMutation('POST', h({ origin: 'https://www.lagrailla.es:8443', host: 'www.lagrailla.es' }))).toBe(true);
    expect(isCrossOriginMutation('POST', h({ origin: 'https://evil.lagrailla.es', host: 'www.lagrailla.es' }))).toBe(true);
  });

  it('bloquea Origin "null" y orígenes que no son una URL', () => {
    expect(isCrossOriginMutation('POST', h({ origin: 'null', host: 'www.lagrailla.es' }))).toBe(true);
    expect(isCrossOriginMutation('POST', h({ origin: 'no es una url', host: 'www.lagrailla.es' }))).toBe(true);
  });

  it('bloquea Sec-Fetch-Site cross-site aunque no haya Origin', () => {
    expect(isCrossOriginMutation('POST', h({ 'sec-fetch-site': 'cross-site', host: 'www.lagrailla.es' }))).toBe(true);
    expect(isCrossOriginMutation('POST', h({ 'sec-fetch-site': 'same-origin', host: 'www.lagrailla.es' }))).toBe(false);
  });

  it('deja pasar a quien no es un navegador (sin Origin): curl, cron, webhooks', () => {
    expect(isCrossOriginMutation('POST', h({ host: 'www.lagrailla.es' }))).toBe(false);
  });
});

describe('isOriginCheckExempt', () => {
  it('exime webhooks, cron y NextAuth', () => {
    expect(isOriginCheckExempt('/api/webhooks/stripe')).toBe(true);
    expect(isOriginCheckExempt('/api/cron/reconcile-payments')).toBe(true);
    expect(isOriginCheckExempt('/api/auth/callback/credentials')).toBe(true);
  });

  it('no exime el resto de la API', () => {
    expect(isOriginCheckExempt('/api/orders')).toBe(false);
    expect(isOriginCheckExempt('/api/admin/config')).toBe(false);
  });
});
