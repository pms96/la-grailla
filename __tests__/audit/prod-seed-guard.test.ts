// AUDIT: PROD-01 — scripts/safe-seed.ts solo comprobaba que scripts/seed.ts no
// tuviera prisma.delete/deleteMany, pero no comprobaba a qué base de datos
// apuntaba DATABASE_URL. Ejecutar `npm run seed` con el .env apuntando por error
// a una base de datos remota (staging/producción) sembraría/sobrescribiría datos
// reales sin ningún aviso.
//
// isLocalDatabaseUrl se extrae a su propio módulo (scripts/is-local-database-url.ts)
// para poder testearla sin importar safe-seed.ts, que tiene efectos de módulo
// (process.exit, y al final execSync del seed real) no aptos para un test unitario.
import { describe, it, expect } from 'vitest';
import { isLocalDatabaseUrl } from '../../scripts/is-local-database-url';

describe('AUDIT — isLocalDatabaseUrl (guard de scripts/safe-seed.ts)', () => {
  it('reconoce localhost y 127.0.0.1 como locales', () => {
    expect(isLocalDatabaseUrl('postgresql://user:pass@localhost:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgresql://user:pass@127.0.0.1:5432/db')).toBe(true);
  });

  it('rechaza un host remoto', () => {
    expect(isLocalDatabaseUrl('postgresql://role:pass@db-14e126c982.db006.hosteddb.reai.io:5432/db')).toBe(false);
    expect(isLocalDatabaseUrl('postgresql://user:pass@ep-cool-name-123456.eu-central-1.aws.neon.tech/db')).toBe(false);
  });

  it('rechaza una URL vacía o inválida en vez de lanzar', () => {
    expect(isLocalDatabaseUrl('')).toBe(false);
    expect(isLocalDatabaseUrl('no-es-una-url')).toBe(false);
  });

  it('no se deja engañar por "localhost" en el nombre de usuario o la ruta', () => {
    expect(isLocalDatabaseUrl('postgresql://localhost:pass@remoto.example.com:5432/db')).toBe(false);
  });
});
