import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Limpia filas de `AdminAuditLog` al terminar un test. La BD las protege con un trigger de solo inserción (H-026); la salida de emergencia es declarar, DENTRO de
 * la transacción, `app.audit_maintenance`. Solo para tests: en la aplicación no hay (ni debe haber) ninguna ruta que modifique la auditoría.
 */
/**
 * Limpieza de fin de suite (H-013): borra las filas de `AdminAuditLog` creadas desde `since` cuyo autor NO es una persona real, es decir, sin autor, sin fila
 * de usuario o con un usuario de correo de prueba (`@example.com`, `@example.org`, `@test.local`). Los tests de rutas simulan la sesión con ids inventados y
 * dejaban cientos de filas en la BD de desarrollo. Solo lo anterior a `since` y lo de usuarios reales se conserva. Devuelve cuántas borró.
 */
export async function purgeTestAuditRows(client: { $transaction(fn: (tx: Pick<Prisma.TransactionClient, '$executeRaw'>) => Promise<number>): Promise<number> }, since: Date): Promise<number> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'purge-audit-log', true)`;
    return tx.$executeRaw`DELETE FROM "AdminAuditLog" WHERE "createdAt" >= ${since} AND ("actorId" IS NULL OR "actorId" NOT IN (SELECT "id" FROM "User" WHERE "email" !~ '@(example\\.(com|org)|test\\.local)$'))`;
  });
}

export async function purgeAuditLog(where: Prisma.AdminAuditLogWhereInput): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'purge-audit-log', true)`;
    return (await tx.adminAuditLog.deleteMany({ where })).count;
  });
}
