import { describe, expect, it } from 'vitest';
import { resolveStoreKind } from '@/lib/registry/store';

/* En un servidor, `memory` «publica» en la memoria de cada instancia: el front no ve nada y todos los clientes dan 404 sin un solo error.
 * Estas pruebas fijan que en producción (o sin decir nada) eso es un error, no un valor por defecto. */

describe('qué almacén del registro se usa', () => {
  it('upstash vale en cualquier entorno', () => {
    expect(resolveStoreKind({ REGISTRY_STORE: 'upstash', NODE_ENV: 'production' })).toBe('upstash');
    expect(resolveStoreKind({ REGISTRY_STORE: 'upstash' })).toBe('upstash');
  });

  it('memory vale en tests y en desarrollo', () => {
    expect(resolveStoreKind({ REGISTRY_STORE: 'memory', NODE_ENV: 'test' })).toBe('memory');
    expect(resolveStoreKind({ REGISTRY_STORE: 'memory', NODE_ENV: 'development' })).toBe('memory');
    expect(resolveStoreKind({ REGISTRY_STORE: 'memory' })).toBe('memory'); // script local con tsx
  });

  it('memory en producción es un error', () => {
    expect(() => resolveStoreKind({ REGISTRY_STORE: 'memory', NODE_ENV: 'production' })).toThrow(/producción/);
    expect(() => resolveStoreKind({ REGISTRY_STORE: 'memory', VERCEL: '1' })).toThrow(/producción/);
  });

  it('sin REGISTRY_STORE solo se asume memory en tests y en desarrollo', () => {
    expect(resolveStoreKind({ NODE_ENV: 'test' })).toBe('memory');
    expect(resolveStoreKind({ NODE_ENV: 'development' })).toBe('memory');
  });

  it('sin REGISTRY_STORE en producción, en Vercel o en un script sin NODE_ENV es un error que dice qué poner', () => {
    expect(() => resolveStoreKind({ NODE_ENV: 'production' })).toThrow(/REGISTRY_STORE=upstash/);
    expect(() => resolveStoreKind({ VERCEL: '1' })).toThrow(/REGISTRY_STORE=upstash/);
    expect(() => resolveStoreKind({})).toThrow(/REGISTRY_STORE=upstash/);
  });

  it('un valor desconocido es un error', () => {
    expect(() => resolveStoreKind({ REGISTRY_STORE: 'redis' })).toThrow(/desconocido/);
  });
});
