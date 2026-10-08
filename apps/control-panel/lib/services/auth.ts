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

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60_000;

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const totpScope = (operatorId: string) => ({ scope: `operator:${operatorId}`, field: 'totp' });
const asActor = (op: Operator, ctx: SessionContext): Actor => ({ id: op.id, email: op.email, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });

/**
 * Reserva UN intento de forma atómica ANTES de comprobar la contraseña o el código.
 * Contar el fallo después no sirve: una ráfaga de peticiones en paralelo leería todas el
 * mismo contador y se verificarían todas. Aquí el propio UPDATE decide (la fila se bloquea),
 * así que en cada ventana solo llegan a verificarse MAX_FAILED_LOGINS intentos, vengan
 * en serie o en paralelo. Devuelve el nº de intento (1..MAX) o null si la cuenta está bloqueada.
 * Al llegar al MAX el bloqueo queda fijado en ese mismo UPDATE.
 */
async function reserveAttempt(operatorId: string, now: number): Promise<number | null> {
  const at = new Date(now);
  const until = new Date(now + LOCK_MS);
  const rows = await prisma.$queryRaw<{ failedLogins: number }[]>`
    UPDATE "Operator" SET
      "failedLogins" = (CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${at} THEN 1 ELSE "failedLogins" + 1 END),
      "lockedUntil" = (CASE WHEN (CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${at} THEN 1 ELSE "failedLogins" + 1 END) >= ${MAX_FAILED_LOGINS}
                            THEN ${until} ELSE NULL END)
    WHERE id = ${operatorId} AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${at})
    RETURNING "failedLogins"`;
  return rows.length ? rows[0].failedLogins : null;
}

/** La contraseña era correcta: se devuelve el intento reservado (el MFA sigue contando el suyo). */
async function refundAttempt(operatorId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "Operator" SET "failedLogins" = GREATEST("failedLogins" - 1, 0) WHERE id = ${operatorId} AND "lockedUntil" IS NULL`;
}

async function clearAttempts(tx: Prisma.TransactionClient, operatorId: string): Promise<void> {
  await tx.operator.update({ where: { id: operatorId }, data: { failedLogins: 0, lockedUntil: null } });
}

/**
 * Anota un fallo. Solo se llama para intentos que llegaron a verificarse, que son como mucho
 * MAX por ventana: el registro inmutable no se puede inflar desde fuera.
 */
async function auditFailure(op: Operator, ctx: SessionContext, kind: 'password' | 'mfa', attempt: number): Promise<void> {
  const locked = attempt >= MAX_FAILED_LOGINS;
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
    await reserveAttempt('no-existe', now);
    await burnPasswordCheck(password);
    return { status: 'invalid' };
  }
  const attempt = await reserveAttempt(op.id, now);
  if (attempt === null) {
    await burnPasswordCheck(password);
    return { status: 'invalid' }; // bloqueada: misma respuesta que una contraseña errónea
  }
  if (!(await verifyPassword(password, op.passwordHash))) {
    await auditFailure(op, ctx, 'password', attempt);
    return { status: 'invalid' };
  }
  await refundAttempt(op.id);
  // Las sesiones pre-MFA que nadie llegó a usar no se limpiarían solas: se borran aquí, de forma barata.
  await prisma.operatorSession.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
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

  const attempt = await reserveAttempt(op.id, now);
  if (attempt === null) return { status: 'locked' };

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
    await auditFailure(op, ctx, 'mfa', attempt);
    return attempt >= MAX_FAILED_LOGINS ? { status: 'locked' } : { status: 'invalid' };
  }
  await prisma.$transaction(async (tx) => {
    await clearAttempts(tx, op.id);
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
  const attempt = await reserveAttempt(op.id, now);
  if (attempt === null) return { status: 'invalid' };
  const secret = await openField(op.totpSecretEnc, totpScope(op.id));
  const step = verifyTotp(secret, codeRaw, now, null);
  if (step === null) {
    await auditFailure(op, ctx, 'mfa', attempt);
    return { status: 'invalid' };
  }
  const recoveryCodes = generateRecoveryCodes();
  await prisma.$transaction(async (tx) => {
    await tx.operator.update({
      where: { id: op.id },
      data: { totpEnabledAt: new Date(now), totpLastStep: step, recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode), failedLogins: 0, lockedUntil: null },
    });
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
  const attempt = await reserveAttempt(op.id, now);
  if (attempt === null) throw new ServiceError('locked', 'Demasiados intentos. Cuenta bloqueada temporalmente.');
  if (!(await verifyPassword(current, op.passwordHash))) {
    await auditFailure(op, ctx, 'password', attempt);
    throw new ServiceError('invalid_password', 'La contraseña actual no es correcta');
  }
  const problem = passwordPolicyError(next, op.email);
  if (problem) throw new ServiceError('weak_password', problem);
  if (await verifyPassword(next, op.passwordHash)) throw new ServiceError('same_password', 'La nueva contraseña debe ser distinta de la actual');
  const passwordHash = await hashPassword(next);
  await prisma.$transaction(async (tx) => {
    await tx.operator.update({ where: { id: op.id }, data: { passwordHash, mustChangePassword: false, failedLogins: 0, lockedUntil: null } });
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
