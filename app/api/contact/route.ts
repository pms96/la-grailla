export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { handleApiError } from '@/lib/api-error';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { CONTACT_HONEYPOT_FIELD, contactNotificationEmail, contactSchema, isContactFormEnabled } from '@/lib/contact';

/* Formulario de contacto de la web pública (núcleo). Público: sin sesión. Defensas: interruptor por cliente, límite de ritmo por IP,
 * campo trampa para bots, validación estricta, consentimiento RGPD y tope de tamaño. */

function tooMany(retryAfter: number) {
  return NextResponse.json(
    { error: 'Has enviado demasiados mensajes. Espera un rato e inténtalo de nuevo.' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}

export async function POST(request: Request) {
  try {
    if (!(await isContactFormEnabled())) {
      return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
    }
    const raw = await request.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return NextResponse.json({ error: 'Datos no válidos' }, { status: 400 });

    // Un bot rellena el campo oculto: respondemos «bien» sin guardar nada, para no darle una pista de qué lo delató.
    const trap = (raw as Record<string, unknown>)[CONTACT_HONEYPOT_FIELD];
    if (typeof trap === 'string' && trap.trim() !== '') return NextResponse.json({ success: true });

    const ip = getClientIp(request);
    const parsed = contactSchema.safeParse(raw);
    if (!parsed.success) {
      // Un envío con datos erróneos no gasta el cupo de envíos buenos (quien se equivoca de email no se queda sin poder reintentar), pero
      // tiene su propio tope más holgado para que no sirva de martillo.
      const invalid = await rateLimit('contact-invalid', ip, 30, 60 * 60_000);
      if (!invalid.ok) return tooMany(invalid.retryAfter);
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Datos no válidos' }, { status: 400 });
    }
    // Cupo por IP (5/h) y tope global del cliente (100/h): muchas IPs, o un /64 de IPv6, no pueden inundar su bandeja ni su correo.
    const perIp = await rateLimit('contact', ip, 5, 60 * 60_000);
    if (!perIp.ok) return tooMany(perIp.retryAfter);
    const global = await rateLimit('contact-all', 'cliente', 100, 60 * 60_000);
    if (!global.ok) return tooMany(global.retryAfter);
    const data = parsed.data;
    const saved = await prisma.contactMessage.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone || null,
        subject: data.subject || null,
        message: data.message,
        consentAt: new Date(),
      },
    });

    // Aviso al operador del cliente. Si no tiene admin_email el mensaje queda igualmente en la bandeja; nunca se envía a otra dirección.
    const to = await getOperatorEmail();
    if (to) {
      const mail = await contactNotificationEmail(saved);
      const sent = await sendMail({ to, subject: mail.subject, html: mail.html, replyTo: saved.email });
      if (!sent.success) console.error('[contact] aviso no enviado:', saved.id, sent.error);
    } else {
      console.error('[contact] admin_email no configurado: el mensaje queda solo en la bandeja', saved.id);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'POST /api/contact');
  }
}
