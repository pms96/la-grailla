export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { handleApiError } from '@/lib/api-error';

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
    const { companyName, contactName, email, phone, sponsorType, message } = createSponsorRequestSchema.parse(
      await request.json()
    );

    const sponsorReq = await prisma.sponsorRequest.create({
      data: { companyName, contactName, email, phone, sponsorType, message },
    });

    // Notify admin
    const adminHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #a855f7; border-bottom: 2px solid #a855f7; padding-bottom: 10px;">Nueva Solicitud de Patrocinio</h2>
        <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Empresa:</strong> ${companyName}</p>
          <p><strong>Contacto:</strong> ${contactName}</p>
          <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
          <p><strong>Tel\u00e9fono:</strong> ${phone ?? 'No proporcionado'}</p>
          <p><strong>Tipo:</strong> ${sponsorType}</p>
          ${message ? `<p><strong>Mensaje:</strong></p><div style="background: white; padding: 15px; border-radius: 4px; border-left: 4px solid #a855f7;">${message}</div>` : ''}
        </div>
      </div>
    `;

    await sendMail({
      subject: `Nueva solicitud de patrocinio: ${companyName}`,
      html: adminHtml,
      to: 'grupolagrailla@gmail.com',
      replyTo: email,
    });

    // Confirm to sponsor
    const confirmHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #a855f7;">Solicitud Recibida</h2>
        <p>Hola ${contactName},</p>
        <p>Hemos recibido tu solicitud de patrocinio para <strong>La Grailla</strong>.</p>
        <p>Nos pondremos en contacto contigo lo antes posible.</p>
        <p style="color: #666; margin-top: 30px;">Equipo La Grailla</p>
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
