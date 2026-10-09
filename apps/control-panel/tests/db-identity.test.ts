import { describe, expect, it } from 'vitest';
import { assertSameDatabase, databaseFingerprint, databaseIdentity } from '@/lib/services/db-identity';

const neon = (id: string, over: { pooler?: boolean; db?: string; port?: string } = {}) =>
  `postgresql://u:p@ep-${id}${over.pooler ? '-pooler' : ''}.eu-central-1.aws.neon.tech${over.port ? `:${over.port}` : ''}/${over.db ?? 'neondb'}?sslmode=require`;

describe('identidad de una BD', () => {
  it('servidor, puerto y nombre; sin usuario ni contraseña', () => {
    expect(databaseIdentity(neon('abc'))).toEqual({ host: 'ep-abc.eu-central-1.aws.neon.tech', port: '5432', db: 'neondb' });
    expect(JSON.stringify(databaseIdentity(neon('abc')))).not.toMatch(/u:p|sslmode/);
  });

  it('la URL con pooler y la directa de Neon son la misma BD', () => {
    expect(databaseFingerprint(neon('abc', { pooler: true }))).toBe(databaseFingerprint(neon('abc')));
  });

  it('no depende de mayúsculas, del usuario ni de los parámetros', () => {
    expect(databaseFingerprint('postgresql://otro:otra@EP-ABC.EU-CENTRAL-1.AWS.NEON.TECH/neondb?sslmode=require&x=1')).toBe(databaseFingerprint(neon('abc')));
  });

  it('otro servidor, otro puerto u otro nombre de BD es otra BD', () => {
    const base = databaseFingerprint(neon('abc'));
    expect(databaseFingerprint(neon('xyz'))).not.toBe(base);
    expect(databaseFingerprint(neon('abc', { port: '6543' }))).not.toBe(base);
    expect(databaseFingerprint(neon('abc', { db: 'otra' }))).not.toBe(base);
  });

  it('el puerto por defecto es 5432', () => {
    expect(databaseFingerprint(neon('abc', { port: '5432' }))).toBe(databaseFingerprint(neon('abc')));
  });

  it('la huella es un hash: no revela el servidor', () => {
    expect(databaseFingerprint(neon('abc'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('la URL con pooler y la directa deben ser de la misma BD', () => {
  it('Neon: el mismo servidor con y sin pooler vale', () => {
    expect(() => assertSameDatabase(neon('abc', { pooler: true }), neon('abc'))).not.toThrow();
  });

  it('Neon: servidores distintos no valen (un copia-pega del proyecto de otro cliente)', () => {
    expect(() => assertSameDatabase(neon('abc', { pooler: true }), neon('xyz'))).toThrow(expect.objectContaining({ code: 'database_mismatch' }));
  });

  it('mismo servidor y nombre de BD distinto no vale', () => {
    expect(() => assertSameDatabase(neon('abc'), neon('abc', { db: 'otra' }))).toThrow(expect.objectContaining({ code: 'database_mismatch' }));
  });

  it('otros proveedores (otro host para el pooler) solo se comprueban en lo que se puede saber', () => {
    expect(() => assertSameDatabase('postgresql://u:p@pooler.proveedor.com:6543/app?sslmode=require', 'postgresql://u:p@db.proveedor.com:5432/app?sslmode=require')).not.toThrow();
  });
});
