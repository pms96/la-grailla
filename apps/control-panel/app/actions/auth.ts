'use server';

import { redirect } from 'next/navigation';
import { currentSession, requirePreMfa } from '@/lib/guard';
import { changePassword, completeTotpSetup, loginWithPassword, verifyMfa } from '@/lib/services/auth';
import { destroySession } from '@/lib/session';
import { clearSessionCookie, readSessionToken, requestContext, setSessionCookie } from '@/lib/session-cookie';
import type { ActionState } from '../_components/action-form';
import { str, toState } from './util';

const GENERIC_LOGIN_ERROR = 'Credenciales incorrectas o cuenta bloqueada temporalmente.';

/** Dónde sigue el login según lo que falte. */
function nextStep(s: { mustChangePassword: boolean; needsTotpSetup: boolean }): string {
  if (s.mustChangePassword) return '/account/password';
  return s.needsTotpSetup ? '/account/mfa' : '/login/mfa';
}

export async function loginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const result = await loginWithPassword(str(fd, 'email'), str(fd, 'password'), requestContext());
    if (result.status !== 'mfa_required') return { error: GENERIC_LOGIN_ERROR };
    setSessionCookie(result.token, 'pre-mfa');
    redirect(nextStep(result));
  } catch (err) {
    return toState(err);
  }
}

export async function mfaAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const token = readSessionToken();
    if (!token) redirect('/login');
    const res = await verifyMfa(token, str(fd, 'code'), requestContext());
    if (res.status === 'locked') return { error: 'Demasiados intentos. Cuenta bloqueada temporalmente.' };
    if (res.status !== 'ok') return { error: 'Código incorrecto.' };
    setSessionCookie(res.token, 'full');
    redirect('/');
  } catch (err) {
    return toState(err);
  }
}

export async function changePasswordAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const live = await requirePreMfa();
    const token = readSessionToken()!;
    const next = str(fd, 'next');
    if (next !== str(fd, 'confirm')) return { error: 'Las contraseñas nuevas no coinciden.' };
    await changePassword(token, str(fd, 'current'), next, requestContext());
    // Sin MFA activado, sigue la configuración; con él, sesión completa → inicio.
    redirect(live.mfaVerified ? '/' : live.operator.totpEnabledAt ? '/login/mfa' : '/account/mfa');
  } catch (err) {
    return toState(err);
  }
}

export async function completeTotpAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requirePreMfa();
    const token = readSessionToken()!;
    const res = await completeTotpSetup(token, str(fd, 'code'), requestContext());
    if (res.status !== 'ok') return { error: 'Código incorrecto. Comprueba la hora de tu móvil e inténtalo de nuevo.' };
    setSessionCookie(res.token, 'full');
    return {
      ok: 'Verificación en dos pasos activada.',
      reveal: {
        title: 'Códigos de recuperación',
        lines: res.recoveryCodes,
        note: 'Guárdalos ahora en un gestor de contraseñas. Cada uno vale una sola vez y no se volverán a mostrar. Después ve a Inicio.',
      },
    };
  } catch (err) {
    return toState(err);
  }
}

export async function logoutAction(): Promise<void> {
  const live = await currentSession();
  if (live) await destroySession(readSessionToken());
  clearSessionCookie();
  redirect('/login');
}
