import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { shouldMigrateOnBuild, skipReason, withMigrationTimeouts, migrationEnv, migrateDeployInvocation } = createRequire(import.meta.url)('../../scripts/build.js') as {
  shouldMigrateOnBuild: (env: Record<string, string | undefined>) => boolean;
  skipReason: (env: Record<string, string | undefined>) => string;
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

  // H-127: antes solo valía exactamente «1»; `true`, `on` o `yes` seguían migrando la BD real.
  it('H-127: también lo apagan true, yes, si, on (sin importar mayúsculas ni espacios) y cualquier valor raro: ante la duda, no se migra', () => {
    for (const v of ['true', 'TRUE', ' yes ', 'si', 'On', 'x', 'quizá', '2']) expect(shouldMigrateOnBuild({ SKIP_MIGRATE_ON_BUILD: v }), JSON.stringify(v)).toBe(false);
    for (const v of ['', '0', 'false', 'No', 'OFF', '  ']) expect(shouldMigrateOnBuild({ SKIP_MIGRATE_ON_BUILD: v }), JSON.stringify(v)).toBe(true);
  });

  it('H-127: una vista previa de Vercel NUNCA migra, aunque no tenga la variable (el proyecto antiguo compartía la BD real con los Preview)', () => {
    expect(shouldMigrateOnBuild({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(shouldMigrateOnBuild({ VERCEL_ENV: 'preview', SKIP_MIGRATE_ON_BUILD: '0' })).toBe(false);
    expect(shouldMigrateOnBuild({ VERCEL_ENV: 'production' })).toBe(true); // producción sí, como siempre
    expect(shouldMigrateOnBuild({ VERCEL_ENV: 'development' })).toBe(true);
  });

  it('el motivo del salto sale en el log del build', () => {
    expect(skipReason({ PLATFORM_MODE: 'on' })).toBe('PLATFORM_MODE=on');
    expect(skipReason({ SKIP_MIGRATE_ON_BUILD: 'true' })).toBe('SKIP_MIGRATE_ON_BUILD=true');
    expect(skipReason({ VERCEL_ENV: 'preview' })).toMatch(/vistas previas/);
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

