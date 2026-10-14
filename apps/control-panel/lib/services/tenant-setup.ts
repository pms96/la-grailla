import type { ActingOperator } from '../actor';
import { appendAudit } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { openField } from '../secrets-store';
import { ServiceError } from './errors';
import { readOnboarding, seedTenantDb } from './provision';
import { DB_URL_DIRECT_FIELD } from './tenants';

/* «Datos iniciales» de un cliente YA registrado y migrado: el email de avisos, los tres textos legales y el primer usuario administrador de su
 * web. Es lo que el alta por asistente (o por script) hace al sembrar, para el cliente que se registró sin ello (por el formulario simple o porque
 * el alta se cortó). Repetible: no pisa lo que ya tiene valor ni crea un segundo administrador, y la contraseña solo existe la primera vez. */

export type SeedInput = {
  /** Destinatario de los avisos del cliente (obligatorio para publicar). */
  adminEmail: string;
  adminName?: string;
  /** Usuario administrador de la web; por defecto, el mismo correo. */
  adminUserEmail?: string;
  legal: { legal_notice?: string; privacy_policy?: string; cookies_policy?: string };
};

export type SeedResult = {
  configWritten: string[];
  /** Solo si se ha creado el usuario ahora; no se puede volver a ver. */
  adminPassword?: string;
  adminEmail: string;
  /** Datos mínimos que siguen sin completar tras sembrar. */
  missing: string[];
};

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export async function seedExistingTenant(subscriptionId: string, input: SeedInput, actor: ActingOperator): Promise<SeedResult> {
  // Escribe en la BD del cliente y puede crear un usuario con contraseña: es una acción de superadmin, como el alta.
  assertCan(actor.role, 'tenants:write');
  assertCan(actor.role, 'database:write');

  const adminEmail = input.adminEmail.trim().toLowerCase();
  if (!isEmail(adminEmail)) throw new ServiceError('invalid_admin_email', 'El email de administración no es válido');
  const adminUserEmail = (input.adminUserEmail ?? adminEmail).trim().toLowerCase();
  if (!isEmail(adminUserEmail)) throw new ServiceError('invalid_admin_user', 'El correo del usuario administrador no es válido');

  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { tenant: true } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  if (sub.tenant.status === 'PENDING_DELETION' || sub.tenant.status === 'DELETED') throw new ServiceError('invalid_state', 'Este cliente está en borrado');
  if (sub.schemaVersion === null) throw new ServiceError('migrate_first', 'Migra la base de datos del cliente antes de sembrar sus datos (botón «Migrar BD»)');

  const config: Record<string, string> = {
    admin_email: adminEmail,
    ...Object.fromEntries(Object.entries(input.legal).filter(([, v]) => (v ?? '').trim()).map(([k, v]) => [k, (v as string).trim()])),
  };
  const dbUrl = await openField(sub.dbUrlDirectEnc, { scope: sub.tenantId, field: DB_URL_DIRECT_FIELD });
  const seeded = await seedTenantDb(dbUrl, { tenantId: sub.tenantId, config, adminEmail: adminUserEmail, adminName: input.adminName?.trim() || 'Administrador', createAdmin: true });
  const missing = await readOnboarding(dbUrl);

  await prisma.$transaction((tx) =>
    appendAudit(tx, {
      actor,
      action: 'tenant.seed',
      targetType: 'subscription',
      targetId: subscriptionId,
      tenantId: sub.tenantId,
      // Solo nombres de claves y un booleano: ni la contraseña ni los textos ni los correos.
      meta: { written: seeded.configWritten, adminCreated: !!seeded.adminPassword, missing },
    })
  );
  return { configWritten: seeded.configWritten, adminPassword: seeded.adminPassword, adminEmail: adminUserEmail, missing };
}
