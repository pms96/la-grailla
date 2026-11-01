import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { nonLocalDatabaseVars } from '../helpers/require-local-db';
import { purgeTestAuditRows } from '../helpers/audit';
import { recoverConfigJournal } from '../helpers/config-journal';

/* Limpieza de fin de suite (H-013), vía `globalSetup` de vitest.config.mts. Los tests de rutas simulan la sesión con ids inventados y cada acción deja una fila
 * en AdminAuditLog; al ser la tabla de solo inserción (H-026) ningún test podía limpiarlas y la BD de desarrollo acumulaba cientos. Al terminar la ejecución se
 * borran las creadas desde que arrancó y cuyo autor no es una persona real (ver `purgeTestAuditRows`). Solo contra una base local, igual que la suite. */
/* H-151: además, devuelve a su sitio la configuración que los tests pisaron (diario de `tests/helpers/config-journal.ts`). Al ARRANCAR, para reparar una ejecución anterior
 * abortada con Ctrl-C o kill (que no llegó a su `afterAll`); al TERMINAR, para reparar un test que olvidó restaurar. Si algo se recuperó, se avisa por consola. */
async function recoverConfig(label: string) {
  if (nonLocalDatabaseVars().length > 0 || !process.env.DATABASE_URL) return;
  const client = new PrismaClient();
  try {
    const keys = await recoverConfigJournal(client);
    if (keys.length > 0) console.warn(`[tests] ${label}: se restauró la configuración que un test dejó pisada (${keys.join(', ')}).`);
  } catch (error) {
    // Aquí NO se calla en silencio: si no se pudo restaurar, el diario sigue en disco y hay que saberlo.
    console.error('[tests] no se pudo restaurar la configuración apuntada en el diario:', error instanceof Error ? error.message : error);
  } finally {
    await client.$disconnect();
  }
}

export default async function setup() {
  await recoverConfig('al arrancar');
  const startedAt = new Date();
  return async function teardown() {
    await recoverConfig('al terminar');
    if (nonLocalDatabaseVars().length > 0 || !process.env.DATABASE_URL) return;
    const client = new PrismaClient();
    try {
      await purgeTestAuditRows(client, startedAt);
    } catch (error) {
      // La limpieza es una comodidad: un fallo no debe tumbar una suite que ha pasado.
      console.warn('[tests] no se pudo limpiar la auditoría de pruebas:', error instanceof Error ? error.message : error);
    } finally {
      await client.$disconnect();
    }
  };
}
