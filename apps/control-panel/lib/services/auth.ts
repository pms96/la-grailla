import type { Operator, OperatorRole, Prisma } from '@prisma/client';
import type { ActingOperator } from '../actor';
import { appendAudit, type Actor } from '../audit';
import { prisma } from '../db';
import { assertCan } from '../permissions';
import {
  burnPasswordCheck,
  generateTemporaryPassword,
  hashPassword,
  passwordPolicyError,
  verifyPassword,
} from '../password';
import { openField, sealField } from '../secrets-store';
import {
  createSession,
  destroyAllSessions,
  getSession,
  hashToken,
  promoteSession,
  type SessionContext,
} from '../session';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from '../totp';
import { ServiceError } from './errors';

/** Fallos permitidos por (cuenta, IP) en cada ventana (H-170). */
export const MAX_FAILED_LOGINS = 5;
/** Fallos permitidos para la cuenta ENTERA, sumando todas las IPs (H-170): la defensa contra una fuerza bruta repartida entre muchas IPs. */
export const MAX_FAILED_LOGINS_ACCOUNT = 30;
export const LOCK_MS = 15 * 60_000;

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const totpScope = (operatorId: string) => ({ scope: `operator:${operatorId}`, field: 'totp' });
const asActor = (op: Operator, ctx: SessionContext): Actor => ({ id: op.id, email: op.email, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });

/**
 * Reserva UN intento de forma atómica ANTES de comprobar la contraseña o el código.
 * Contar el fallo después no sirve: una ráfaga de peticiones en paralelo leería todas el
 * mismo contador y se verificarían todas. Aquí el propio UPDATE decide (la fila se bloquea),
 * así que en cada ventana solo llegan a verificarse MAX_FAILED_LOGINS intentos por IP, vengan
 * en serie o en paralelo.
 *
 * H-170: el cupo es por (cuenta, IP). Quien conoce el email de un operador agota SU cupo desde
 * SU IP, pero no bloquea al operador, que entra desde la suya. Si la IP ya está bloqueada no se
 * toca nada más (martillear desde ella no gasta el contador de la cuenta). Aparte, la cuenta
 * tiene un tope MAYOR sumando todas las IPs (MAX_FAILED_LOGINS_ACCOUNT): una fuerza bruta
 * repartida entre muchas IPs sí la bloquea, y se levanta con `unlockOperator`.
 *
 * Devuelve null si está bloqueado (la IP o la cuenta), o el nº de intento de esta IP y si este
 * intento deja el bloqueo fijado (cualquiera de los dos).
 */
type Reservation = { attempt: number; locked: boolean };

async function reserveAttempt(operatorId: string, ip: string, now: number): Promise<Reservation | null> {
  const at = new Date(now);
  const until = new Date(now + LOCK_MS);
  const bucket = await prisma.$queryRaw<{ failedLogins: number }[]>`
    INSERT INTO "OperatorLoginBucket" ("operatorId", "ip", "failedLogins", "lockedUntil", "updatedAt")
    VALUES (${operatorId}, ${ip}, 1, ${MAX_FAILED_LOGINS <= 1 ? until : null}, ${at})
    ON CONFLICT ("operatorId", "ip") DO UPDATE SET
      "failedLogins" = (CASE WHEN "OperatorLoginBucket"."lockedUntil" IS NOT NULL AND "OperatorLoginBucket"."lockedUntil" <= ${at} THEN 1 ELSE "OperatorLoginBucket"."failedLogins" + 1 END),
      "lockedUntil" = (CASE WHEN (CASE WHEN "OperatorLoginBucket"."lockedUntil" IS NOT NULL AND "OperatorLoginBucket"."lockedUntil" <= ${at} THEN 1 ELSE "OperatorLoginBucket"."failedLogins" + 1 END) >= ${MAX_FAILED_LOGINS}
                            THEN ${until} ELSE NULL END),
      "updatedAt" = ${at}
    WHERE "OperatorLoginBucket"."lockedUntil" IS NULL OR "OperatorLoginBucket"."lockedUntil" <= ${at}
    RETURNING "failedLogins"`;
  if (!bucket.length) return null; // esta IP está bloqueada para esta cuenta

  const account = await prisma.$queryRaw<{ failedLogins: number }[]>`
    UPDATE "Operator" SET
      "failedLogins" = (CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${at} THEN 1 ELSE "failedLogins" + 1 END),
      "lockedUntil" = (CASE WHEN (CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${at} THEN 1 ELSE "failedLogins" + 1 END) >= ${MAX_FAILED_LOGINS_ACCOUNT}
                            THEN ${until} ELSE NULL END)
    WHERE id = ${operatorId} AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${at})
    RETURNING "failedLogins"`;
  if (!account.length) return null; // la cuenta entera está bloqueada
  const attempt = bucket[0].failedLogins;
  return { attempt, locked: attempt >= MAX_FAILED_LOGINS || account[0].failedLogins >= MAX_FAILED_LOGINS_ACCOUNT };
}

/** La contraseña era correcta: se devuelve el intento reservado (el MFA sigue contando el suyo), en el cupo de la IP y en el de la cuenta. */
async function refundAttempt(operatorId: string, ip: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "OperatorLoginBucket" SET "failedLogins" = GREATEST("failedLogins" - 1, 0) WHERE "operatorId" = ${operatorId} AND "ip" = ${ip} AND "lockedUntil" IS NULL`;
  await prisma.$executeRaw`UPDATE "Operator" SET "failedLogins" = GREATEST("failedLogins" - 1, 0) WHERE id = ${operatorId} AND "lockedUntil" IS NULL`;
}

/** Un acceso completo limpia el contador de la cuenta y el cupo de ESA IP (los de otras IPs siguen su curso). */
async function clearAttempts(tx: Prisma.TransactionClient, operatorId: string, ip: string): Promise<void> {
  await tx.operator.update({ where: { id: operatorId }, data: { failedLogins: 0, lockedUntil: null } });
  await tx.operatorLoginBucket.deleteMany({ where: { operatorId, ip } });
}

/** El mismo trabajo en BD que `reserveAttempt` para una cuenta que no existe (o está deshabilitada): la respuesta no se distingue por el tiempo. */
async function decoyAttempt(): Promise<void> {
  await prisma.$queryRaw`SELECT 1 FROM "OperatorLoginBucket" WHERE "operatorId" = ${'no-existe'} LIMIT 1`;
  await prisma.$queryRaw`SELECT "failedLogins" FROM "Operator" WHERE id = ${'no-existe'}`;
}

/**
 * Levanta el bloqueo de una cuenta: el contador y bloqueo de la cuenta y todos los cupos por IP. Lo usan el script `operator:unlock` y (H-170) el panel.
 */
export async function unlockOperator(operatorId: string, actor: Actor, meta: Record<string, unknown> = {}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.operator.update({ where: { id: operatorId }, data: { failedLogins: 0, lockedUntil: null } });
    await tx.operatorLoginBucket.deleteMany({ where: { operatorId } });
    await appendAudit(tx, { actor, action: 'operator.unlock', targetType: 'operator', targetId: operatorId, meta });
  });
}

const ipOf = (ctx: SessionContext) => (ctx.ip && ctx.ip.trim() ? ctx.ip.trim().slice(0, 64) : 'unknown');

/**
 * Anota un fallo. Solo se llama para intentos que llegaron a verificarse, que son como mucho
 * MAX por ventana: el registro inmutable no se puede inflar desde fuera.
 */
async function auditFailure(op: Operator, ctx: SessionContext, kind: 'password' | 'mfa', reservation: Reservation): Promise<void> {
  const { attempt, locked } = reservation;
  await prisma.$transaction((tx) =>
    appendAudit(tx, {
      actor: asActor(op, ctx),
      action: locked ? 'auth.locked' : kind === 'password' ? 'auth.login_failed' : 'auth.mfa_failed',
      targetType: 'operator',
      targetId: op.id,
      meta: locked ? { minutes: LOCK_MS / 60_000 } : { attempt },
    })
  );
}

export type LoginResult = { status: 'mfa_required'; token: string; mustChangePassword: boolean; needsTotpSetup: boolean } | { status: 'invalid' };

/**
 * Paso 1: email + contraseña. Respuesta idéntica (y tiempo parecido) para email
 * inexistente, contraseña errónea, cuenta bloqueada o deshabilitada: no revela
 * qué cuentas existen. Los fallos de emails que no existen NO se auditan (un
 * panel expuesto a Internet no debe dejar que el ruido anónimo infle un registro inmutable).
 */
export async function loginWithPassword(emailRaw: string, password: string, ctx: SessionContext, now: number = Date.now()): Promise<LoginResult> {
  const email = normalizeEmail(emailRaw);
  const op = email.length <= 254 ? await prisma.operator.findUnique({ where: { email } }) : null;
  if (!op || op.disabledAt) {
    // Mismo trabajo (reserva en BD + bcrypt) que una cuenta real: no se distingue por el tiempo.
    await decoyAttempt();
    await burnPasswordCheck(password);
    return { status: 'invalid' };
  }
  const reservation = await reserveAttempt(op.id, ipOf(ctx), now);
  if (reservation === null) {
    await burnPasswordCheck(password);
    return { status: 'invalid' }; // bloqueada: misma respuesta que una contraseña errónea
  }
  if (!(await verifyPassword(password, op.passwordHash))) {
    await auditFailure(op, ctx, 'password', reservation);
    return { status: 'invalid' };
  }
  await refundAttempt(op.id, ipOf(ctx));
  // Las sesiones pre-MFA que nadie llegó a usar no se limpiarían solas: se borran aquí, de forma barata.
  await prisma.operatorSession.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  // Cupos por IP que llevan más de un día sin actividad (el bloqueo dura 15 min): no se acumulan.
  await prisma.operatorLoginBucket.deleteMany({ where: { updatedAt: { lt: new Date(now - 24 * 3_600_000) } } });
  const token = await createSession(op.id, ctx, { mfaVerified: false }, now);
  return { status: 'mfa_required', token, mustChangePassword: op.mustChangePassword, needsTotpSetup: op.totpEnabledAt === null };
}

async function preMfaSession(token: string, now: number) {
  const live = await getSession(token, now);
  if (!live) throw new ServiceError('session_expired', 'La sesión ha caducado: vuelve a iniciar sesión');
  return live;
}

export type MfaResult = { status: 'ok'; token: string } | { status: 'invalid' } | { status: 'locked' };

/** Paso 2: código TOTP o un código de recuperación. */
export async function verifyMfa(token: string, codeRaw: string, ctx: SessionContext, now: number = Date.now()): Promise<MfaResult> {
  const live = await preMfaSession(token, now);
  const op = live.operator;
  if (live.mfaVerified) return { status: 'ok', token };
  if (!op.totpEnabledAt || !op.totpSecretEnc) throw new ServiceError('totp_not_configured', 'Primero hay que configurar la verificación en dos pasos');
  if (op.mustChangePassword) throw new ServiceError('password_change_required', 'Hay que cambiar la contraseña antes de continuar');

  const reservation = await reserveAttempt(op.id, ipOf(ctx), now);
  if (reservation === null) return { status: 'locked' };

  let ok = false;
  const code = codeRaw.trim();
  if (looksLikeRecoveryCode(code)) {
    // Atómico en SQL: dos usos simultáneos del mismo código (o de dos códigos distintos) no se pisan.
    const hash = hashRecoveryCode(code);
    const used = await prisma.$executeRaw`UPDATE "Operator" SET "recoveryCodeHashes" = array_remove("recoveryCodeHashes", ${hash}) WHERE id = ${op.id} AND ${hash} = ANY("recoveryCodeHashes")`;
    ok = used === 1;
    if (ok) {
      await prisma.$transaction((tx) =>
        appendAudit(tx, { actor: asActor(op, ctx), action: 'auth.recovery_code_used', targetType: 'operator', targetId: op.id, meta: { remaining: op.recoveryCodeHashes.length - 1 } })
      );
    }
  } else {
    const secret = await openField(op.totpSecretEnc, totpScope(op.id));
    const step = verifyTotp(secret, code, now, op.totpLastStep);
    if (step !== null) {
      // Condición en el WHERE: si otra petición ya consumió este intervalo, no cuenta.
      const res = await prisma.operator.updateMany({
        where: { id: op.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: { totpLastStep: step },
      });
      ok = res.count === 1;
    }
  }
  if (!ok) {
    await auditFailure(op, ctx, 'mfa', reservation);
    return reservation.locked ? { status: 'locked' } : { status: 'invalid' };
  }
  await prisma.$transaction(async (tx) => {
    await clearAttempts(tx, op.id, ipOf(ctx));
    await appendAudit(tx, { actor: asActor(op, ctx), action: 'auth.login', targetType: 'operator', targetId: op.id, meta: {} });
  });
  return { status: 'ok', token: await promoteSession(token, ctx, now) };
}

/** Prepara (o recupera) el secreto TOTP pendiente y devuelve lo que hay que mostrar. */
export async function startTotpSetup(token: string, now: number = Date.now()): Promise<{ secret: string; uri: string }> {
  const live = await preMfaSession(token, now);
  const op = live.operator;
  if (op.totpEnabledAt) throw new ServiceError('totp_already_enabled', 'La verificación en dos pasos ya está activada');
  if (op.mustChangePassword) throw new ServiceError('password_change_required', 'Hay que cambiar la contraseña antes de continuar');
  let secret: string;
  if (op.totpSecretEnc) {
    secret = await openField(op.totpSecretEnc, totpScope(op.id));
  } else {
    secret = generateTotpSecret();
    await prisma.operator.update({ where: { id: op.id }, data: { totpSecretEnc: await sealField(secret, totpScope(op.id)) } });
  }
  return { secret, uri: otpauthUri(op.email, secret) };
}

/** Confirma el primer código, activa el TOTP y devuelve los códigos de recuperación (se muestran una sola vez). */
export async function completeTotpSetup(
  token: string,
  codeRaw: string,
  ctx: SessionContext,
  now: number = Date.now()
): Promise<{ status: 'ok'; token: string; recoveryCodes: string[] } | { status: 'invalid' }> {
  const live = await preMfaSession(token, now);
  const op = live.operator;
  if (op.totpEnabledAt || !op.totpSecretEnc) throw new ServiceError('invalid_state', 'No hay una configuración pendiente');
  if (op.mustChangePassword) throw new ServiceError('password_change_required', 'Hay que cambiar la contraseña antes de continuar');
  const reservation = await reserveAttempt(op.id, ipOf(ctx), now);
  if (reservation === null) return { status: 'invalid' };
  const secret = await openField(op.totpSecretEnc, totpScope(op.id));
  const step = verifyTotp(secret, codeRaw, now, null);
  if (step === null) {
    await auditFailure(op, ctx, 'mfa', reservation);
    return { status: 'invalid' };
  }
  const recoveryCodes = generateRecoveryCodes();
  await prisma.$transaction(async (tx) => {
    await tx.operator.update({
      where: { id: op.id },
      data: { totpEnabledAt: new Date(now), totpLastStep: step, recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode), failedLogins: 0, lockedUntil: null },
    });
    await tx.operatorLoginBucket.deleteMany({ where: { operatorId: op.id, ip: ipOf(ctx) } }); // H-170: como el contador de la cuenta, el cupo de esta IP
    await appendAudit(tx, { actor: asActor(op, ctx), action: 'auth.totp_enabled', targetType: 'operator', targetId: op.id, meta: {} });
  });
  return { status: 'ok', token: await promoteSession(token, ctx, now), recoveryCodes };
}

/**
 * Cambio de contraseña (también el obligatorio del primer acceso). Cierra las demás sesiones.
 * Con MFA activado exige sesión COMPLETA: quien solo tiene la contraseña no puede cambiarla
 * y dejar fuera al dueño. La excepción es el primer acceso (contraseña temporal, sin MFA aún).
 */
export async function changePassword(token: string, current: string, next: string, ctx: SessionContext, now: number = Date.now()): Promise<void> {
  const live = await preMfaSession(token, now);
  const op = live.operator;
  const firstAccess = op.mustChangePassword && !op.totpEnabledAt;
  if (!live.mfaVerified && !firstAccess) {
    throw new ServiceError('mfa_required', 'Verifica primero el segundo factor para cambiar la contraseña');
  }
  const reservation = await reserveAttempt(op.id, ipOf(ctx), now);
  if (reservation === null) throw new ServiceError('locked', 'Demasiados intentos. Cuenta bloqueada temporalmente.');
  if (!(await verifyPassword(current, op.passwordHash))) {
    await auditFailure(op, ctx, 'password', reservation);
    throw new ServiceError('invalid_password', 'La contraseña actual no es correcta');
  }
  const problem = passwordPolicyError(next, op.email);
  if (problem) throw new ServiceError('weak_password', problem);
  if (await verifyPassword(next, op.passwordHash)) throw new ServiceError('same_password', 'La nueva contraseña debe ser distinta de la actual');
  const passwordHash = await hashPassword(next);
  await prisma.$transaction(async (tx) => {
    await tx.operator.update({ where: { id: op.id }, data: { passwordHash, mustChangePassword: false, failedLogins: 0, lockedUntil: null } });
    await tx.operatorLoginBucket.deleteMany({ where: { operatorId: op.id, ip: ipOf(ctx) } }); // H-170: como el contador de la cuenta, el cupo de esta IP
    await appendAudit(tx, { actor: asActor(op, ctx), action: 'auth.password_changed', targetType: 'operator', targetId: op.id, meta: {} });
  });
  await destroyAllSessions(op.id, hashToken(token));
}

/* ---- gestión de operadores (solo SUPERADMIN) ---- */

const SUPERADMIN_LOCK = 7002;

/** Serializa los cambios que pueden dejar el panel sin superadministrador (dos a la vez no se pueden quitar mutuamente). */
async function assertAnotherSuperadmin(tx: Prisma.TransactionClient, excludeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPERADMIN_LOCK})`;
  const others = await tx.operator.count({ where: { role: 'SUPERADMIN', disabledAt: null, id: { not: excludeId } } });
  if (others === 0) throw new ServiceError('last_superadmin', 'No se puede dejar el panel sin ningún superadministrador activo');
}

/** Crea un operador con contraseña temporal (se devuelve UNA vez; debe cambiarla en el primer acceso). */
export async function createOperator(input: { email: string; name: string; role: OperatorRole }, actor: ActingOperator) {
  assertCan(actor.role, 'operators:manage');
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new ServiceError('invalid_email', 'El email no es válido');
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new ServiceError('invalid_name', 'El nombre debe tener entre 2 y 120 caracteres');
  if (await prisma.operator.findUnique({ where: { email } })) throw new ServiceError('email_taken', 'Ya existe un operador con ese email');
  const temporaryPassword = generateTemporaryPassword();
  const operator = await prisma.$transaction(async (tx) => {
    const op = await tx.operator.create({ data: { email, name, role: input.role, passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true } });
    await appendAudit(tx, { actor, action: 'operator.create', targetType: 'operator', targetId: op.id, meta: { email, role: input.role } });
    return op;
  });
  return { operator, temporaryPassword };
}

export async function setOperatorDisabled(operatorId: string, disabled: boolean, actor: ActingOperator) {
  assertCan(actor.role, 'operators:manage');
  await prisma.$transaction(async (tx) => {
    const op = await tx.operator.findUnique({ where: { id: operatorId } });
    if (!op) throw new ServiceError('not_found', 'Operador no encontrado');
    if (disabled && op.role === 'SUPERADMIN') await assertAnotherSuperadmin(tx, op.id);
    await tx.operator.update({ where: { id: op.id }, data: { disabledAt: disabled ? new Date() : null, failedLogins: 0, lockedUntil: null } });
    await appendAudit(tx, { actor, action: disabled ? 'operator.disable' : 'operator.enable', targetType: 'operator', targetId: op.id, meta: { email: op.email } });
  });
  if (disabled) await destroyAllSessions(operatorId);
}

export async function setOperatorRole(operatorId: string, role: OperatorRole, actor: ActingOperator) {
  assertCan(actor.role, 'operators:manage');
  await prisma.$transaction(async (tx) => {
    const op = await tx.operator.findUnique({ where: { id: operatorId } });
    if (!op) throw new ServiceError('not_found', 'Operador no encontrado');
    if (op.role === 'SUPERADMIN' && role !== 'SUPERADMIN') await assertAnotherSuperadmin(tx, op.id);
    await tx.operator.update({ where: { id: op.id }, data: { role } });
    await appendAudit(tx, { actor, action: 'operator.set_role', targetType: 'operator', targetId: op.id, meta: { email: op.email, from: op.role, to: role } });
  });
  await destroyAllSessions(operatorId);
}

/** Reinicia el MFA y la contraseña de un operador (p. ej. perdió el móvil y los códigos). Devuelve la contraseña temporal. */
export async function resetOperatorCredentials(operatorId: string, actor: ActingOperator) {
  assertCan(actor.role, 'operators:manage');
  const op = await prisma.operator.findUnique({ where: { id: operatorId } });
  if (!op) throw new ServiceError('not_found', 'Operador no encontrado');
  const temporaryPassword = generateTemporaryPassword();
  await prisma.$transaction(async (tx) => {
    await tx.operator.update({
      where: { id: op.id },
      data: {
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        totpSecretEnc: null,
        totpEnabledAt: null,
        totpLastStep: null,
        recoveryCodeHashes: [],
        failedLogins: 0,
        lockedUntil: null,
      },
    });
    await appendAudit(tx, { actor, action: 'operator.reset_credentials', targetType: 'operator', targetId: op.id, meta: { email: op.email } });
  });
  await destroyAllSessions(op.id);
  return { temporaryPassword };
}
