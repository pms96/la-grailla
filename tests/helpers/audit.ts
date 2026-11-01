import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Limpia filas de `AdminAuditLog` al terminar un test. La BD las protege con un trigger de solo inserción (H-026); la salida de emergencia es declarar, DENTRO de
 * la transacción, `app.audit_maintenance`. Solo para tests: en la aplicación no hay (ni debe haber) ninguna ruta que modifique la auditoría.
 */
export async function purgeAuditLog(where: Prisma.AdminAuditLogWhereInput): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'purge-audit-log', true)`;
    return (await tx.adminAuditLog.deleteMany({ where })).count;
  });
}
