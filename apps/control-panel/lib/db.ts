import { PrismaClient } from '@prisma/client';

const g = globalThis as unknown as { __controlPrisma?: PrismaClient };

// En tests se exige una BD local cuyo nombre termine en _test (ver tests/setup.ts):
// aquí se repite la comprobación para que ningún import pueda esquivarla.
function assertSafe(url: string | undefined): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) return;
  const u = new URL(url ?? 'postgresql://x/none');
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || !u.pathname.endsWith('_test')) {
    throw new Error('En tests, la BD de control debe ser local y terminar en _test');
  }
}

export const prisma: PrismaClient =
  g.__controlPrisma ??
  (() => {
    assertSafe(process.env.CONTROL_DATABASE_URL);
    return new PrismaClient();
  })();

if (process.env.NODE_ENV !== 'production') g.__controlPrisma = prisma;
