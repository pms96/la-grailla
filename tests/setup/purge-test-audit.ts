import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { nonLocalDatabaseVars } from '../helpers/require-local-db';
import { purgeTestAuditRows } from '../helpers/audit';

/* Limpieza de fin de suite (H-013), vía `globalSetup` de vitest.config.mts. Los tests de rutas simulan la sesión con ids inventados y cada acción deja una fila
 * en AdminAuditLog; al ser la tabla de solo inserción (H-026) ningún test podía limpiarlas y la BD de desarrollo acumulaba cientos. Al terminar la ejecución se
 * borran las creadas desde que arrancó y cuyo autor no es una persona real (ver `purgeTestAuditRows`). Solo contra una base local, igual que la suite. */
export default function setup() {
  const startedAt = new Date();
  return async function teardown() {
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
