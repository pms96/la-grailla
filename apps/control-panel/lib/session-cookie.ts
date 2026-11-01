import { cookies, headers } from 'next/headers';
import { ABSOLUTE_TIMEOUT_MS, PRE_MFA_TIMEOUT_MS } from './session';

const secure = process.env.NODE_ENV === 'production';
// El prefijo __Host- obliga a Secure, Path=/ y sin Domain: la cookie no puede venir de un subdominio.
export const SESSION_COOKIE = secure ? '__Host-cp_session' : 'cp_session';

// Next 15: cookies() y headers() son asíncronas (H-107).
export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function setSessionCookie(token: string, kind: 'full' | 'pre-mfa'): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor((kind === 'full' ? ABSOLUTE_TIMEOUT_MS : PRE_MFA_TIMEOUT_MS) / 1000),
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * IP y user-agent de la petición en curso. `x-vercel-forwarded-for` solo se confía cuando de verdad se sirve desde
 * Vercel (lo fija su edge); en cualquier otro sitio lo puede inventar el cliente.
 */
export async function requestContext(): Promise<{ ip: string; userAgent: string }> {
  const h = await headers();
  const vercel = process.env.VERCEL ? h.get('x-vercel-forwarded-for') : null;
  const fwd = h.get('x-forwarded-for');
  const ip = vercel?.split(',')[0]?.trim() || (fwd ? fwd.split(',').map((v) => v.trim()).filter(Boolean).pop() : null) || h.get('x-real-ip') || 'unknown';
  return { ip, userAgent: h.get('user-agent') ?? '' };
}
