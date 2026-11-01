import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { prisma } from '@/lib/prisma';
import { purgeAuditLog } from '../helpers/audit';

/* H-026: «solo se añade» deja de ser una convención: la BD rechaza editar o borrar filas de AdminAuditLog. */

const ACTOR = `append-only-${Date.now()}`;
const row = () => prisma.adminAuditLog.create({ data: { actorId: ACTOR, action: 'config.update', targetType: 'Test', targetId: 'x', meta: { a: 1 } } });

afterAll(async () => {
  await purgeAuditLog({ actorId: ACTOR });
});

describe('AdminAuditLog es de solo inserción (H-026)', () => {
  it('insertar funciona', async () => {
    const r = await row();
    expect((await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: r.id } })).actorId).toBe(ACTOR);
  });

  it('editar una fila (update, updateMany o SQL) falla y la fila no cambia', async () => {
    const r = await row();
    await expect(prisma.adminAuditLog.update({ where: { id: r.id }, data: { action: 'user.delete' } })).rejects.toThrow(/solo inserción/);
    await expect(prisma.adminAuditLog.updateMany({ where: { id: r.id }, data: { meta: { borrado: true } } })).rejects.toThrow(/solo inserción/);
    await expect(prisma.$executeRaw`UPDATE "AdminAuditLog" SET "actorEmail" = 'otro@x.es' WHERE "id" = ${r.id}`).rejects.toThrow(/solo inserción/);
    const after = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.action).toBe('config.update');
    expect(after.actorEmail).toBeNull();
  });

  it('borrar una fila (delete, deleteMany o SQL) falla y la fila sigue ahí', async () => {
    const r = await row();
    await expect(prisma.adminAuditLog.delete({ where: { id: r.id } })).rejects.toThrow(/solo inserción/);
    await expect(prisma.adminAuditLog.deleteMany({ where: { id: r.id } })).rejects.toThrow(/solo inserción/);
    await expect(prisma.$executeRaw`DELETE FROM "AdminAuditLog" WHERE "id" = ${r.id}`).rejects.toThrow(/solo inserción/);
    expect(await prisma.adminAuditLog.count({ where: { id: r.id } })).toBe(1);
  });

  it('un intento fallido dentro de una transacción la deshace entera (no deja la auditoría a medias)', async () => {
    const r = await row();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.adminAuditLog.create({ data: { actorId: ACTOR, action: 'config.update', targetType: 'Test', targetId: 'dentro-de-la-tx' } });
        await tx.adminAuditLog.delete({ where: { id: r.id } });
      })
    ).rejects.toThrow(/solo inserción/);
    expect(await prisma.adminAuditLog.count({ where: { targetId: 'dentro-de-la-tx' } })).toBe(0);
  });

  it('la salida de emergencia de los tests solo vale dentro de su transacción (no queda abierta en la conexión)', async () => {
    const r = await row();
    expect(await purgeAuditLog({ id: r.id })).toBe(1);
    const next = await row();
    await expect(prisma.adminAuditLog.delete({ where: { id: next.id } })).rejects.toThrow(/solo inserción/);
  });

  it('ninguna ruta de la aplicación edita ni borra auditoría (solo create)', () => {
    const hits = execSync('grep -rnE "adminAuditLog\\.(update|updateMany|delete|deleteMany|upsert)" app lib || true', { cwd: process.cwd(), encoding: 'utf8' }).trim();
    expect(hits).toBe('');
  });
});
