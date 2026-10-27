import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // tsconfig usa `jsx: preserve` (lo compila Next): para probar componentes, Vitest los transforma con el runtime automático de React.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    // dotenv primero (carga el .env) y después la guardia: la suite se niega a arrancar contra una base de datos que no sea local.
    setupFiles: ['dotenv/config', './tests/setup/require-local-db.ts'],
    testTimeout: 15000,
    // Nunca se manda nada a un Sentry ni a un ntfy reales desde la suite, aunque el .env del desarrollador tenga estas variables (P0-07):
    // vacías, el código las trata como «no configurado». Los tests que prueban esos canales inyectan su propio `fetch`/transporte.
    env: { SENTRY_DSN: '', PLATFORM_ALERT_URL: '', PLATFORM_ALERT_TOKEN: '' },
    // Los tests de checkout golpean la base de datos de desarrollo real
    // (igual que el resto del proyecto no tiene mocks de Prisma) — en serie
    // para que no compitan por el stock de las mismas ticketTypes de prueba.
    fileParallelism: false,
    // Las apps de apps/ (panel de control) tienen su propio Prisma, tipos, BD y suite: se prueban aparte.
    exclude: [...configDefaults.exclude, 'apps/**'],
  },
  resolve: {
    alias: {
      '@': rootDir,
      '@grailla/contracts': path.join(rootDir, 'packages/contracts/src'),
    },
  },
});
