import { redirect } from 'next/navigation';
import type { ActingOperator } from './actor';
import { can, type Permission } from './permissions';
import { getSession, type LiveSession } from './session';
import { readSessionToken, requestContext } from './session-cookie';

export async function currentSession(): Promise<LiveSession | null> {
  return getSession(readSessionToken());
}

export function actorOf(live: LiveSession): ActingOperator {
  const ctx = requestContext();
  return { id: live.operator.id, email: live.operator.email, role: live.operator.role, ip: ctx.ip, userAgent: ctx.userAgent };
}

/**
 * Exige una sesión COMPLETA (contraseña + MFA). Cada página y cada acción lo llama por su cuenta:
 * nada depende de que otra capa ya haya comprobado el acceso.
 */
export async function requireOperator(permission: Permission = 'view'): Promise<{ live: LiveSession; actor: ActingOperator }> {
  const live = await currentSession();
  if (!live || !live.mfaVerified) redirect('/login');
  if (live.operator.mustChangePassword) redirect('/login');
  if (!can(live.operator.role, permission)) redirect('/?denied=1');
  return { live, actor: actorOf(live) };
}

/** Para las pantallas intermedias del login (cambio de contraseña, MFA): sesión viva aunque falte el MFA. */
export async function requirePreMfa(): Promise<LiveSession> {
  const live = await currentSession();
  if (!live) redirect('/login');
  return live;
}
