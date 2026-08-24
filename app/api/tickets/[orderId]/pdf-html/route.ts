export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateQRDataUrl } from '@/lib/qr';
import { handleApiError } from '@/lib/api-error';

export async function GET(
  request: Request,
  { params }: { params: { orderId: string } }
) {
  try {
    const order = await prisma.order.findUnique({
      where: { id: params?.orderId },
      include: {
        event: true,
        tickets: { include: { ticketType: true } },
      },
    });

    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    const logoUrl = (process.env.NEXTAUTH_URL ?? '') + '/brand/logo-black.png';
    const ticketHtmls: string[] = [];
    for (const ticket of (order.tickets ?? [])) {
      const qrDataUrl = await generateQRDataUrl(ticket?.qrCode ?? '');
      const eventDate = order.event?.date ? new Date(order.event.date).toLocaleDateString('es-ES', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      }) : '';

      ticketHtmls.push(`
        <div style="page-break-after: always; padding: 40px; font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="${logoUrl}" alt="La Grailla" height="32" style="height:32px;width:auto;" />
            <p style="color: #666; margin: 5px 0;">Entrada Digital</p>
          </div>
          <div style="background: #f9fafb; border-radius: 12px; padding: 24px; margin-bottom: 20px;">
            <h2 style="margin: 0 0 8px; color: #1a1a1a;">${order.event?.name ?? ''}</h2>
            <p style="margin: 4px 0; color: #555;">\ud83d\udcc5 ${eventDate}</p>
            <p style="margin: 4px 0; color: #555;">\ud83d\udccd ${order.event?.venue ?? ''} \u2014 ${order.event?.city ?? ''}</p>
            <p style="margin: 4px 0; color: #555;">\ud83d\udeaa Apertura: ${order.event?.doorsOpen ?? ''}</p>
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <img src="${qrDataUrl}" width="250" height="250" style="border: 2px solid #e5e7eb; border-radius: 8px;" />
            <p style="font-family: monospace; font-size: 12px; color: #999; margin-top: 8px;">${ticket?.qrCode ?? ''}</p>
          </div>
          <div style="background: #f3f0ff; border-radius: 8px; padding: 16px;">
            <p style="margin: 4px 0;"><strong>Titular:</strong> ${ticket?.holderName ?? ''}</p>
            <p style="margin: 4px 0;"><strong>Tipo:</strong> ${ticket?.ticketType?.name ?? 'General'}</p>
            <p style="margin: 4px 0;"><strong>ID:</strong> ${ticket?.id?.slice(0, 8) ?? ''}</p>
          </div>
          <p style="text-align: center; font-size: 11px; color: #aaa; margin-top: 20px;">Presenta este c\u00f3digo QR en la entrada del evento. No compartas este c\u00f3digo.</p>
        </div>
      `);
    }

    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Entradas - ${order.event?.name ?? ''}</title></head><body style="margin:0;padding:0;">${ticketHtmls.join('')}</body></html>`;

    return new NextResponse(fullHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (error) {
    return handleApiError(error, 'GET /api/tickets/[orderId]/pdf-html');
  }
}
