import { describe, it, expect } from 'vitest';
import { enabledModules, hasModule, isUlid, newUlid, normalizeHost } from '../src';

describe('newUlid / isUlid', () => {
  it('genera 26 caracteres Crockford que pasan isUlid', () => {
    const id = newUlid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it('es ordenable por tiempo', () => {
    const rand = () => new Uint8Array(16);
    const a = newUlid(1_700_000_000_000, rand);
    const b = newUlid(1_700_000_000_001, rand);
    const c = newUlid(1_800_000_000_000, rand);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it('codifica el instante conocido (vector fijo)', () => {
    expect(newUlid(0, () => new Uint8Array(16))).toBe('00000000000000000000000000');
    expect(newUlid(1_700_000_000_000, () => new Uint8Array(16)).slice(0, 10)).toBe('01HF7YAT00');
  });

  it('dos ids consecutivos no coinciden', () => {
    expect(newUlid()).not.toBe(newUlid());
  });

  it('rechaza tiempos fuera de rango', () => {
    expect(() => newUlid(-1)).toThrow(RangeError);
    expect(() => newUlid(2 ** 48)).toThrow(RangeError);
  });

  it.each(['', 'abc', 'I'.repeat(26), '8'.repeat(26), '0'.repeat(25), '0'.repeat(27)])('isUlid rechaza %j', (v) => {
    expect(isUlid(v)).toBe(false);
  });
});

describe('normalizeHost', () => {
  it.each([
    ['Cliente.ES', 'cliente.es'],
    ['  www.Cliente.es.  ', 'www.cliente.es'],
    ['cliente.es:8443', 'cliente.es'],
    ['t1.test', 't1.test'],
    ['a.localhost', 'a.localhost'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it.each(['', 'localhost', 'evil.com/x', 'user@evil.com', 'evil .com', 'bücher.example', '-a.com', 'a..com', '1.2.3.4', 'x.c', 'a.com\nb.com'])(
    'rechaza %j',
    (input) => {
      expect(normalizeHost(input)).toBeNull();
    }
  );
});

describe('módulos', () => {
  it('el núcleo siempre está activo', () => {
    expect(enabledModules([])).toEqual(['nucleo']);
  });

  it('ignora módulos desconocidos (deny) y conserva el orden canónico', () => {
    expect(enabledModules(['wallets', 'inventado', 'tienda'])).toEqual(['nucleo', 'tienda', 'wallets']);
    expect(hasModule(['tienda'], 'entradas')).toBe(false);
    expect(hasModule(['tienda'], 'tienda')).toBe(true);
  });
});
