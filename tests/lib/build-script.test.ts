import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { shouldMigrateOnBuild } = createRequire(import.meta.url)('../../scripts/build.js') as { shouldMigrateOnBuild: (env: Record<string, string | undefined>) => boolean };

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
