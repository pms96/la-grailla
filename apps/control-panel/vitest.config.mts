import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 20000,
    // Todos los tests comparten la BD de control de pruebas.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': root,
      '@grailla/contracts': path.join(root, '../../packages/contracts/src'),
      zod: path.join(root, 'node_modules/zod'),
    },
  },
});
