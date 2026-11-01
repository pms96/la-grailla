export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { handleApiError } from '@/lib/api-error';
import { consumePasswordToken } from '@/lib/password-setup';
import { getClientIp, rateLimit, refundRateLimit } from '@/lib/rate-limit';

/* Fijar la contraseña con el enlace de una invitación del panel (fase 3). Público: el token del enlace es la credencial. Defensas: límite
 * de ritmo por IP y global del cliente (adivinar un token de 256 bits no es viable, pero no hay por qué dejar que se intente sin freno),
 * una sola respuesta de fallo para token malo/caducado/usado, y contraseña mínima. */

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const perIp = await rateLimit('set-password', ip, 10, 15 * 60_000);
    // H-062: el tope global cuenta FALLOS (se devuelve si el enlace sale bien) y es holgado: con 200 por hora, quien tuviera muchas IPs lo agotaba y dejaba
    // a todos sin poder fijar su contraseña. Adivinar un token de 256 bits no es viable; esto solo frena el ruido.
    const global = await rateLimit('set-password-all', 'cliente', 1000, 60 * 60_000);
    if (!perIp.ok || !global.ok) {
      const retryAfter = Math.max(perIp.retryAfter, global.retryAfter);
      return NextResponse.json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' }, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
    }
    const raw = await request.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return NextResponse.json({ error: 'Datos no válidos' }, { status: 400 });
    const { token, password } = raw as Record<string, unknown>;

    const result = await consumePasswordToken(token, password);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    await refundRateLimit('set-password-all', 'cliente');
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'POST /api/auth/set-password');
  }
}
