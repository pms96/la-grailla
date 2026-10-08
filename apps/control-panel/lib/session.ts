import crypto from 'node:crypto';
import type { Operator, OperatorSession } from '@prisma/client';
import { prisma } from './db';

export const IDLE_TIMEOUT_MS = 30 * 60_000;
export const ABSOLUTE_TIMEOUT_MS = 8 * 3_600_000;
export const PRE_MFA_TIMEOUT_MS = 10 * 60_000;
const TOUCH_EVERY_MS = 60_000;

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

export type SessionContext = { ip?: string | null; userAgent?: string | null };

/** Crea una sesión y devuelve el token en claro (solo se guarda su hash). */
export async function createSession(operatorId: string, ctx: SessionContext, opts: { mfaVerified: boolean }, now: number = Date.now()): Promise<string> {
  const token = newToken();
  await prisma.operatorSession.create({
    data: {
      tokenHash: hashToken(token),
      operatorId,
      mfaVerifiedAt: opts.mfaVerified ? new Date(now) : null,
      createdAt: new Date(now),
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + (opts.mfaVerified ? ABSOLUTE_TIMEOUT_MS : PRE_MFA_TIMEOUT_MS)),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
    },
  });
  return token;
}

export type LiveSession = { session: OperatorSession; operator: Operator; mfaVerified: boolean };

/** Resuelve un token a su sesión si sigue viva; si caducó por inactividad o por tiempo total, la borra. */
export async function getSession(token: string | undefined | null, now: number = Date.now()): Promise<LiveSession | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const session = await prisma.operatorSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { operator: true } });
  if (!session) return null;
  const { operator, ...s } = session;
  const idleExpired = now - s.lastSeenAt.getTime() > (s.mfaVerifiedAt ? IDLE_TIMEOUT_MS : PRE_MFA_TIMEOUT_MS);
  if (s.expiresAt.getTime() <= now || idleExpired || operator.disabledAt) {
    await prisma.operatorSession.deleteMany({ where: { id: s.id } });
    return null;
  }
  if (now - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await prisma.operatorSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date(now) } });
  }
  return { session: s, operator, mfaVerified: s.mfaVerifiedAt !== null };
}

export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await prisma.operatorSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function destroyAllSessions(operatorId: string, exceptTokenHash?: string): Promise<void> {
  await prisma.operatorSession.deleteMany({ where: { operatorId, ...(exceptTokenHash ? { tokenHash: { not: exceptTokenHash } } : {}) } });
}

/** Tras superar el MFA se cambia el token (evita fijación de sesión) y arranca el plazo completo. */
export async function promoteSession(oldToken: string, ctx: SessionContext, now: number = Date.now()): Promise<string> {
  const old = await prisma.operatorSession.findUnique({ where: { tokenHash: hashToken(oldToken) } });
  if (!old) throw new Error('sesión no encontrada');
  await prisma.operatorSession.delete({ where: { id: old.id } });
  return createSession(old.operatorId, ctx, { mfaVerified: true }, now);
}
