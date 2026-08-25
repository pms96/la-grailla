export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { handleApiError } from '@/lib/api-error';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

// Los campos del formulario van directos al HTML de dos emails reales (a
// grupolagrailla@gmail.com y al remitente) — sin escapar, cualquiera podía
// meter HTML/enlaces en "Mensaje" y que llegara con apariencia manipulada.
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const createSponsorRequestSchema = z.object({
  companyName: z.string().min(1),
  contactName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  sponsorType: z.string().min(1),
  message: z.string().optional().nullable(),
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

    const { companyName, contactName, email, phone, sponsorType, message } = createSponsorRequestSchema.parse(
      await request.json()
    );

    const sponsorReq = await prisma.sponsorRequest.create({
      data: { companyName, contactName, email, phone, sponsorType, message },
    });

    const adminHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #a855f7; border-bottom: 2px solid #a855f7; padding-bottom: 10px;">Nueva Solicitud de Patrocinio</h2>
        <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Empresa:</strong> ${esc(companyName)}</p>
          <p><strong>Contacto:</strong> ${esc(contactName)}</p>
          <p><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>
          <p><strong>Tel\u00e9fono:</strong> ${esc(phone) || 'No proporcionado'}</p>
          <p><strong>Tipo:</strong> ${esc(sponsorType)}</p>
          ${message ? `<p><strong>Mensaje:</strong></p><div style="background: white; padding: 15px; border-radius: 4px; border-left: 4px solid #a855f7;">${esc(message)}</div>` : ''}
        </div>
      </div>
    `;

    await sendMail({
      subject: `Nueva solicitud de patrocinio: ${companyName}`,
      html: adminHtml,
      to: 'grupolagrailla@gmail.com',
      replyTo: email,
    });

    const logoUrl = (process.env.NEXTAUTH_URL ?? '') + '/brand/logo-black.png';
    const confirmHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #a855f7;">Solicitud Recibida</h2>
        <p>Hola ${esc(contactName)},</p>
        <p>Hemos recibido tu solicitud de patrocinio para <strong>La Grailla</strong>.</p>
        <p>Nos pondremos en contacto contigo lo antes posible.</p>
        <p style="margin-top: 30px;"><img src="${logoUrl}" alt="La Grailla" height="24" style="height:24px;width:auto;" /></p>
      </div>
    `;

    await sendMail({
      subject: 'Solicitud de patrocinio recibida - La Grailla',
      html: confirmHtml,
      to: email,
    });

    return NextResponse.json({ success: true, id: sponsorReq.id });
  } catch (error) {
    return handleApiError(error, 'POST /api/sponsors');
  }
}
