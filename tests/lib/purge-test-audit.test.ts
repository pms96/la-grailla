import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { purgeAuditLog, purgeTestAuditRows } from '../helpers/audit';

/* H-013: los tests de rutas dejaban filas en AdminAuditLog de la BD de desarrollo (más de 400) y, con el trigger de solo inserción (H-026), nada las podía
 * borrar. Al terminar la suite se purgan las filas creadas DURANTE la ejecución cuyo autor es de pruebas; las de personas reales (un usuario con un correo
 * de verdad) se conservan aunque se hayan escrito en esa ventana. */

const TAG = `purge-test-${Date.now()}`;
const REAL_ID = `${TAG}-real`;
const REAL_EMAIL = `${TAG}@clientereal.es`;

afterAll(async () => {
  await purgeAuditLog({ actorId: { startsWith: TAG } });
  await prisma.user.delete({ where: { id: REAL_ID } }).catch(() => {});
});

const row = (actorId: string | null, actorEmail: string | null, createdAt?: Date) =>
  prisma.adminAuditLog.create({ data: { actorId, actorEmail, action: 'config.update', targetType: 'Test', targetId: TAG, ...(createdAt ? { createdAt } : {}) } });

describe('limpieza de la auditoría de pruebas (H-013)', () => {
  it('borra lo de actores de prueba creado desde el inicio y conserva lo anterior y lo de personas reales', async () => {
    await prisma.user.create({ data: { id: REAL_ID, email: REAL_EMAIL, role: 'ADMIN' } });
    const since = new Date(Date.now() - 1000);
    const viejo = await row(`${TAG}-viejo`, null, new Date(since.getTime() - 60_000));
    const sinUsuario = await row(`${TAG}-sin-usuario`, null);
    const sinActor = await row(null, null);
    const correoDePrueba = await row(`${TAG}-test`, `${TAG}@example.com`);
    const real = await row(REAL_ID, REAL_EMAIL);

    const borradas = await purgeTestAuditRows(prisma, since);
    expect(borradas).toBeGreaterThanOrEqual(3);

    const quedan = new Set((await prisma.adminAuditLog.findMany({ where: { targetId: TAG }, select: { id: true } })).map((r) => r.id));
    expect(quedan.has(sinUsuario.id)).toBe(false);
    expect(quedan.has(sinActor.id)).toBe(false);
    expect(quedan.has(correoDePrueba.id)).toBe(false);
    expect(quedan.has(viejo.id)).toBe(true); // anterior a la ejecución: no es de esta suite
    expect(quedan.has(real.id)).toBe(true); // una persona real
  });
});
