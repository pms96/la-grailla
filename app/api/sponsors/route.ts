export const dynamic = 'force-dynamic';

import { getFallbackBaseUrl } from '@/lib/url';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { handleApiError } from '@/lib/api-error';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { normalizePhone } from '@/lib/phone';
import { getBrand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';
import { escapeHtml as esc } from '@/lib/html-escape';
import { normalizePublicUrl } from '@/lib/safe-url';
import { captchaRejection, verifyCaptcha } from '@/lib/captcha';

// Los campos del formulario van directos al HTML de dos emails reales (a administrador y al remitente): todos pasan por `esc` (que escapa también las
// comillas, porque `website` y `email` van dentro de un `href`).

// Esta confirmación se manda a CUALQUIER email que se escriba en el formulario: el nombre de contacto sale en su primera línea, así que no puede llevar un enlace
// ni una dirección (sería un mensaje de phishing con la marca del cliente a una víctima ajena). H-105.
const CONTACT_NAME_WITH_LINK = /:\/\/|www\.|@|\.(com|es|net|org|io|co|me|ly|gl|app|xyz|top|info|biz|cc|tk|ru|cn)\b/i;

const createSponsorRequestSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z
    .string()
    .min(1)
    .max(100)
    .refine((v) => !CONTACT_NAME_WITH_LINK.test(v), { message: 'El nombre de contacto no puede incluir enlaces ni direcciones' }),
  email: z.string().email().max(255),
  phone: z.string().max(30).optional().nullable(),
  // Solo una dirección web http(s) (con o sin «https://»): va dentro de un `href` del correo al operador.
  website: z
    .string()
    .max(300)
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v == null || v.trim() === '') return null;
      const url = normalizePublicUrl(v);
      if (!url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Escribe una dirección web válida (por ejemplo https://tuempresa.com)' });
        return z.NEVER;
      }
      return url;
    }),
  message: z.string().max(5000).optional().nullable(),
  // Token del captcha (Turnstile) si el cliente lo tiene activado; ver lib/captcha.ts.
  captchaToken: z.string().max(2100).optional(),
  // Checkbox obligatorio del formulario público — el alta manual desde admin
  // no lo exige (consentimiento obtenido por otra vía).
  consentAccepted: z.literal(true, {
    errorMap: () => ({ message: 'Debes aceptar la política de privacidad para enviar la solicitud' }),
  }),
});

export async function POST(request: Request) {
  try {
    const limit = await rateLimit('sponsors', getClientIp(request), 5, 60 * 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Has enviado demasiadas solicitudes. Espera un rato e inténtalo de nuevo.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const { companyName, contactName, email, phone, website, message, captchaToken } = createSponsorRequestSchema.parse(
      await request.json()
    );

    // Captcha del cliente (si lo tiene activado) ANTES de escribir nada y de mandar ningún correo.
    const captcha = await verifyCaptcha(request, captchaToken, 'sponsor');
    if (!captcha.ok) return captchaRejection(captcha);

    // Tope por DESTINATARIO: el de la IP (arriba) lo esquiva quien cambie de IP, y este formulario manda un correo a la dirección que se escriba. Va con el hash
    // del email (el buzón no queda en claro en la tabla de topes).
    const emailLimit = await rateLimit('sponsors-email', createHash('sha256').update(email.trim().toLowerCase()).digest('hex'), 3, 24 * 60 * 60_000);
    if (!emailLimit.ok) {
      return NextResponse.json(
        { error: 'Ya hemos recibido varias solicitudes con este email. Espera un día o escríbenos directamente.' },
        { status: 429, headers: { 'Retry-After': String(emailLimit.retryAfter) } }
      );
    }

    const sponsorReq = await prisma.sponsorRequest.create({
      data: {
        companyName,
        contactName,
        email,
        phone: normalizePhone(phone),
        website,
        // El tipo de patrocinio ya no se pide en el formulario público — el
        // admin lo asigna después desde /admin/sponsors/[id].
        message,
        consentAt: new Date(),
      },
    });

    const adminHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #a855f7; border-bottom: 2px solid #a855f7; padding-bottom: 10px;">Nueva Solicitud de Patrocinio</h2>
        <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Empresa:</strong> ${esc(companyName)}</p>
          <p><strong>Contacto:</strong> ${esc(contactName)}</p>
          <p><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>
          <p><strong>Tel\u00e9fono:</strong> ${esc(phone) || 'No proporcionado'}</p>
          <p><strong>Web/redes:</strong> ${website ? `<a href="${esc(website)}">${esc(website)}</a>` : 'No proporcionada'}</p>
          ${message ? `<p><strong>Mensaje:</strong></p><div style="background: white; padding: 15px; border-radius: 4px; border-left: 4px solid #a855f7;">${esc(message)}</div>` : ''}
        </div>
      </div>
    `;

    // Sin destinatario configurado (cliente nuevo sin admin_email) la solicitud queda guardada y no se avisa a nadie más.
    const operatorEmail = await getOperatorEmail('sponsors');
    if (operatorEmail) {
      await sendMail({
        subject: `Nueva solicitud de patrocinio: ${companyName}`,
        html: adminHtml,
        to: operatorEmail,
        replyTo: email,
      });
    } else {
      console.error('[sponsors] admin_email no está configurado: no se avisa de la solicitud', sponsorReq.id);
    }

    const brand = await getBrand();
    const logoHtml = brandLogoHtml(brand, getFallbackBaseUrl(), 24);
    const confirmHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: ${brand.colors.emailAccent};">Solicitud Recibida</h2>
        <p>Hola ${esc(contactName)},</p>
        <p>Hemos recibido tu solicitud de patrocinio para <strong>${esc(brand.name)}</strong>.</p>
        <p>Nos pondremos en contacto contigo lo antes posible.</p>
        <p style="margin-top: 30px;">${logoHtml}</p>
      </div>
    `;

    const confirmResult = await sendMail({
      subject: `Solicitud de patrocinio recibida - ${brand.name}`,
      html: confirmHtml,
      to: email,
    });

    await prisma.sponsorEmailLog.create({
      data: {
        sponsorRequestId: sponsorReq.id,
        type: 'LEAD_CONFIRMATION',
        recipient: email,
        success: confirmResult.success,
        error: confirmResult.success ? null : (confirmResult.error ?? 'Error desconocido'),
      },
    });

    return NextResponse.json({ success: true, id: sponsorReq.id });
  } catch (error) {
    return handleApiError(error, 'POST /api/sponsors');
  }
}
