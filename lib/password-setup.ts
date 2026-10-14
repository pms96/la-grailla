import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { PASSWORD_TOKEN_PREFIX, hashPasswordToken, passwordProblem } from '@/lib/platform/password-token';

/* Fijar la contraseña con el enlace de una invitación (fase 3). Un solo resultado de fallo («invalid») para token desconocido, caducado,
 * ya usado o de un usuario que ya no existe: quien llega aquí no aprende cuál de los casos fue. */

export type SetPasswordResult = { ok: true } | { ok: false; reason: 'invalid' | 'weak'; message: string };

const INVALID: SetPasswordResult = { ok: false, reason: 'invalid', message: 'El enlace no es válido o ha caducado. Pide una invitación nueva.' };

export async function consumePasswordToken(token: unknown, password: unknown): Promise<SetPasswordResult> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return INVALID;
  const weak = passwordProblem(password);
  if (weak) return { ok: false, reason: 'weak', message: weak };

  const hash = hashPasswordToken(token);
  const row = await prisma.verificationToken.findUnique({ where: { token: hash } });
  if (!row || !row.identifier.startsWith(PASSWORD_TOKEN_PREFIX) || row.expires.getTime() <= Date.now()) return INVALID;
  const email = row.identifier.slice(PASSWORD_TOKEN_PREFIX.length);
  const hashed = await bcrypt.hash(password as string, 12);

  try {
    await prisma.$transaction(async (tx) => {
      // «Reclamar» el token borrándolo: si dos peticiones llegan a la vez con el mismo enlace, solo una ve count = 1.
      const claimed = await tx.verificationToken.deleteMany({ where: { token: hash, expires: { gt: new Date() } } });
      if (claimed.count !== 1) throw new Error('token_not_claimed');
      const updated = await tx.user.updateMany({ where: { email }, data: { hashedPassword: hashed } });
      if (updated.count !== 1) throw new Error('user_not_found');
      // Cualquier otra invitación pendiente de ese usuario queda anulada.
      await tx.verificationToken.deleteMany({ where: { identifier: row.identifier } });
    });
  } catch {
    return INVALID;
  }
  return { ok: true };
}
