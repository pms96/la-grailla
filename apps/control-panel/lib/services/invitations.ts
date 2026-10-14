import type { ActingOperator } from '../actor';
import { appendAudit } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import { openField } from '../secrets-store';
import { PASSWORD_TOKEN_TTL_MS, newPasswordToken, passwordLink, passwordTokenIdentifier } from '../../../../lib/platform/password-token';
import { ServiceError } from './errors';
import { invitationEmail, mailerConfig, smtpMailer, type Mailer } from './mailer';
import { withTenantDb } from './tenant-db';
import { DB_URL_DIRECT_FIELD } from './tenants';

/* Invitación al administrador de la web de un cliente (fase 3): sustituye a «pasar la contraseña temporal por un canal seguro».
 *
 * El panel escribe en la BD del cliente un token de un solo uso (solo su hash) y manda al administrador un enlace a la web del cliente para
 * que fije su propia contraseña. La contraseña no pasa nunca por el panel ni por ningún correo. Si el panel no tiene correo configurado (o
 * el envío falla), el enlace se enseña UNA vez al operador para que lo pase él. Volver a invitar anula las invitaciones anteriores. */

export type InviteResult = {
  userEmail: string;
  host: string;
  expiresAt: Date;
  delivery: 'email' | 'link';
  /** Solo si no se pudo enviar por correo. No se puede volver a ver. */
  link?: string;
  mailError?: string;
};

export type InviteDeps = {
  /** `undefined` = el configurado en el entorno (o ninguno); `null` = sin correo a propósito. */
  mailer?: Mailer | null;
  now?: () => Date;
};

export async function inviteTenantAdmin(subscriptionId: string, opts: { userEmail?: string }, actor: ActingOperator, deps: InviteDeps = {}): Promise<InviteResult> {
  // Escribe en la BD del cliente y concede acceso a su administración: acción de superadmin, como el alta.
  assertCan(actor.role, 'tenants:write');
  assertCan(actor.role, 'database:write');

  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { tenant: true, domains: true } });
  if (!sub) throw new ServiceError('not_found', 'Suscripción no encontrada');
  if (sub.tenant.status === 'PENDING_DELETION' || sub.tenant.status === 'DELETED') throw new ServiceError('invalid_state', 'Este cliente está en borrado');
  if (sub.schemaVersion === null) throw new ServiceError('migrate_first', 'Migra la base de datos del cliente antes de invitar (botón «Migrar BD»)');
  // El enlace apunta a la web del propio cliente: sin un dominio verificado no se abriría.
  const verified = sub.domains.filter((d) => d.status === 'VERIFIED');
  const host = (verified.find((d) => d.isPrimary) ?? verified[0])?.host;
  if (!host) throw new ServiceError('no_verified_domain', 'El cliente aún no tiene un dominio verificado: el enlace no se podría abrir. Verifícalo primero (botón «Salir a producción»).');

  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + PASSWORD_TOKEN_TTL_MS);
  const { token, hash } = newPasswordToken();
  const requested = opts.userEmail?.trim();

  const dbUrl = await openField(sub.dbUrlDirectEnc, { scope: sub.tenantId, field: DB_URL_DIRECT_FIELD });
  const userEmail = await withTenantDb(dbUrl, async (db) => {
    const rows = requested
      ? await db.$queryRawUnsafe<{ email: string }[]>(`SELECT "email" FROM "User" WHERE lower("email") = lower($1) LIMIT 1`, requested)
      : await db.$queryRawUnsafe<{ email: string }[]>(`SELECT "email" FROM "User" WHERE "role" = 'ADMIN' ORDER BY "createdAt" ASC LIMIT 1`);
    const email = rows[0]?.email;
    if (!email) throw new ServiceError('no_admin_user', requested ? 'Ese usuario no existe en la web del cliente' : 'La web del cliente aún no tiene ningún administrador: crea los datos iniciales primero (apartado «Datos iniciales»)');
    // Solo la última invitación vale: las anteriores del mismo usuario se anulan.
    await db.$transaction([
      db.$executeRawUnsafe(`DELETE FROM "VerificationToken" WHERE "identifier" = $1`, passwordTokenIdentifier(email)),
      db.$executeRawUnsafe(`INSERT INTO "VerificationToken" ("identifier", "token", "expires") VALUES ($1, $2, $3)`, passwordTokenIdentifier(email), hash, expiresAt),
    ]);
    return email;
  });

  const link = passwordLink(host, token);
  const mailer = deps.mailer === undefined ? (() => { const cfg = mailerConfig(); return cfg ? smtpMailer(cfg) : null; })() : deps.mailer;
  let delivery: InviteResult['delivery'] = 'link';
  let mailError: string | undefined;
  if (mailer) {
    try {
      await mailer({ to: userEmail, ...invitationEmail({ brandName: sub.tenant.name, link, expiresAt }) });
      delivery = 'email';
    } catch (err) {
      // El detalle (host del SMTP, usuario…) se queda en el log del servidor; al operador se le dice solo que falló.
      console.error('[invite] no se pudo enviar el correo de invitación:', err instanceof Error ? err.message : String(err));
      mailError = 'No se pudo enviar el correo (revisa la configuración SMTP del panel). Pasa tú el enlace.';
    }
  }

  await prisma.$transaction((tx) =>
    appendAudit(tx, {
      actor,
      action: 'tenant.invite',
      targetType: 'subscription',
      targetId: subscriptionId,
      tenantId: sub.tenantId,
      // Ni el enlace, ni el token, ni el correo: solo cómo se entregó y hasta cuándo vale.
      meta: { via: delivery, expiresAt: expiresAt.toISOString() },
    })
  );

  return { userEmail, host, expiresAt, delivery, ...(delivery === 'link' ? { link } : {}), ...(mailError ? { mailError } : {}) };
}
