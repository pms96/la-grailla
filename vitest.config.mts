import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['dotenv/config'],
    testTimeout: 15000,
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
