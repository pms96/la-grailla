import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { shouldMigrateOnBuild, withMigrationTimeouts, migrationEnv, migrateDeployInvocation } = createRequire(import.meta.url)('../../scripts/build.js') as {
  shouldMigrateOnBuild: (env: Record<string, string | undefined>) => boolean;
  withMigrationTimeouts: (url: string) => string;
  migrationEnv: (env: Record<string, string | undefined>) => Record<string, string | undefined>;
  migrateDeployInvocation: (env: Record<string, string | undefined>) => { command: string; args: string[]; env: Record<string, string | undefined> };
};

describe('scripts/build.js: ¿se migra en el build?', () => {
  it('por defecto SÍ (el proyecto actual de La Grailla sigue migrando en el build)', () => {
    expect(shouldMigrateOnBuild({})).toBe(true);
    expect(shouldMigrateOnBuild({ PLATFORM_MODE: 'off' })).toBe(true);
    expect(shouldMigrateOnBuild({ SKIP_MIGRATE_ON_BUILD: '0' })).toBe(true);
    expect(shouldMigrateOnBuild({ SKIP_MIGRATE_ON_BUILD: '' })).toBe(true);
  });

  it('SKIP_MIGRATE_ON_BUILD=1 lo apaga (interruptor reversible por variable de entorno)', () => {
    expect(shouldMigrateOnBuild({ SKIP_MIGRATE_ON_BUILD: '1' })).toBe(false);
  });

  it('el modo plataforma nunca migra en el build', () => {
    expect(shouldMigrateOnBuild({ PLATFORM_MODE: 'on' })).toBe(false);
    expect(shouldMigrateOnBuild({ PLATFORM_MODE: 'on', SKIP_MIGRATE_ON_BUILD: '0' })).toBe(false);
  });

  it('exportar el módulo no ejecuta el build', () => {
    expect(typeof shouldMigrateOnBuild).toBe('function');
  });
});

// H-046: el proyecto antiguo (La Grailla real) migra en el build con `prisma migrate deploy`, sin guarda de venta ni `lock_timeout`: una migración que espera un
// bloqueo (una venta en marcha) retenía las escrituras de la tabla y, con ellas, las ventas. Ahora la conexión de la migración lleva `lock_timeout` y
// `statement_timeout`: si no consigue el bloqueo en unos segundos, la migración falla y el build no sigue (el despliegue no sale; nada se queda a medias).
describe('scripts/build.js: tiempos de la migración del build (H-046)', () => {
  const decode = (url: string) => decodeURIComponent(new URL(url).searchParams.get('options') ?? '');

  it('añade lock_timeout y statement_timeout como parámetros de arranque de la conexión', () => {
    const out = withMigrationTimeouts('postgresql://u:p@host:5432/db?sslmode=require');
    expect(decode(out)).toBe('-c lock_timeout=3000 -c statement_timeout=300000');
    expect(new URL(out).searchParams.get('sslmode')).toBe('require');
  });

  it('conserva unas `options` que ya traiga la URL y no las duplica', () => {
    const out = withMigrationTimeouts('postgresql://u:p@host/db?options=-c%20search_path%3Dpublic');
    expect(decode(out)).toBe('-c search_path=public -c lock_timeout=3000 -c statement_timeout=300000');
    expect(out.match(/options=/g)).toHaveLength(1);
  });

  it('una URL sin parámetros recibe `?` y no `&`', () => {
    expect(withMigrationTimeouts('postgresql://u:p@host/db')).toContain('/db?options=');
  });

  it('una URL ilegible se deja tal cual (la migración fallará por sí sola, no aquí)', () => {
    expect(withMigrationTimeouts('no es una url')).toBe('no es una url');
  });

  it('el entorno de la migración pone los tiempos en DIRECT_URL, que es la que usa Prisma para migrar, y no toca DATABASE_URL (la de la app)', () => {
    const env = migrationEnv({ DIRECT_URL: 'postgresql://u:p@direct/db', DATABASE_URL: 'postgresql://u:p@pooler/db', OTRA: 'x' });
    expect(decode(env.DIRECT_URL!)).toContain('lock_timeout=3000');
    expect(env.DATABASE_URL).toBe('postgresql://u:p@pooler/db');
    expect(env.OTRA).toBe('x');
  });

  it('sin DIRECT_URL no se inventa una: se deja el entorno como está', () => {
    const env = migrationEnv({ DATABASE_URL: 'postgresql://u:p@host/db' });
    expect(env.DIRECT_URL).toBeUndefined();
    expect(env.DATABASE_URL).toBe('postgresql://u:p@host/db');
  });

  it('la invocación real de `prisma migrate deploy` del build lleva ese entorno con los tiempos', () => {
    const inv = migrateDeployInvocation({ DIRECT_URL: 'postgresql://u:p@direct/db', DATABASE_URL: 'postgresql://u:p@pooler/db' });
    expect([inv.command, ...inv.args]).toEqual(['npx', 'prisma', 'migrate', 'deploy']);
    expect(decode(inv.env.DIRECT_URL!)).toContain('lock_timeout=3000');
  });
});

