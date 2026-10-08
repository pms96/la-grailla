import { cookies, headers } from 'next/headers';
import { ABSOLUTE_TIMEOUT_MS, PRE_MFA_TIMEOUT_MS } from './session';

const secure = process.env.NODE_ENV === 'production';
// El prefijo __Host- obliga a Secure, Path=/ y sin Domain: la cookie no puede venir de un subdominio.
export const SESSION_COOKIE = secure ? '__Host-cp_session' : 'cp_session';

export function readSessionToken(): string | undefined {
  return cookies().get(SESSION_COOKIE)?.value;
}

export function setSessionCookie(token: string, kind: 'full' | 'pre-mfa'): void {
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor((kind === 'full' ? ABSOLUTE_TIMEOUT_MS : PRE_MFA_TIMEOUT_MS) / 1000),
  });
}

export function clearSessionCookie(): void {
  cookies().delete(SESSION_COOKIE);
}

/**
 * IP y user-agent de la petición en curso. `x-vercel-forwarded-for` solo se confía cuando de verdad se sirve desde
 * Vercel (lo fija su edge); en cualquier otro sitio lo puede inventar el cliente.
 */
export function requestContext(): { ip: string; userAgent: string } {
  const h = headers();
  const vercel = process.env.VERCEL ? h.get('x-vercel-forwarded-for') : null;
  const fwd = h.get('x-forwarded-for');
  const ip = vercel?.split(',')[0]?.trim() || (fwd ? fwd.split(',').map((v) => v.trim()).filter(Boolean).pop() : null) || h.get('x-real-ip') || 'unknown';
  return { ip, userAgent: h.get('user-agent') ?? '' };
}
