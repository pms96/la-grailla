export const dynamic = 'force-dynamic';

import { getFallbackBaseUrl } from '@/lib/url';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateQRDataUrl } from '@/lib/qr';
import { handleApiError } from '@/lib/api-error';
import { allowOrderAccess, getTokenFromRequest } from '@/lib/access-token';
import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';
import { EVENT_TIMEZONE } from '@/lib/event-time';
import { ticketUnusable } from '@/lib/ticket-validity';

export async function GET(request: Request, props: { params: Promise<{ orderId: string }> }) {
  const params = await props.params;
  try {
    const orderId = params?.orderId;
    if (!(await allowOrderAccess(orderId, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: true,
        tickets: { include: { ticketType: true } },
      },
    });

    if (!order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 });
    }

    // Un pedido anulado, reembolsado o sin pagar, o un evento cancelado, no emite QR (P1-02): se explica en vez de imprimir una entrada que no vale.
    const unusable = ticketUnusable(order, order.event);
    if (unusable) {
      const page = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Entradas no disponibles</title></head><body style="font-family: Arial, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; text-align: center; color: #1a1a1a;"><h1 style="font-size: 20px;">Entradas no disponibles</h1><p style="color: #555;">${esc(unusable.buyerMessage)}</p></body></html>`;
      return new NextResponse(page, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    const brand = await getBrand();
    const logoHtml = brandLogoHtml(brand, getFallbackBaseUrl(), 32);
    const ticketHtmls: string[] = [];
    for (const ticket of (order.tickets ?? [])) {
      const qrDataUrl = await generateQRDataUrl(ticket?.qrCode ?? '');
      const eventDate = order.event?.date ? new Date(order.event.date).toLocaleDateString('es-ES', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: EVENT_TIMEZONE
      }) : '';

      ticketHtmls.push(`
        <div style="page-break-after: always; padding: 40px; font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="text-align: center; margin-bottom: 30px;">
            ${logoHtml}
            <p style="color: #666; margin: 5px 0;">Entrada Digital</p>
          </div>
          <div style="background: #f9fafb; border-radius: 12px; padding: 24px; margin-bottom: 20px;">
            <h2 style="margin: 0 0 8px; color: #1a1a1a;">${esc(order.event?.name)}</h2>
            <p style="margin: 4px 0; color: #555;">\ud83d\udcc5 ${esc(eventDate)}</p>
            <p style="margin: 4px 0; color: #555;">\ud83d\udccd ${esc(order.event?.venue)} \u2014 ${esc(order.event?.city)}</p>
            <p style="margin: 4px 0; color: #555;">\ud83d\udeaa Apertura: ${esc(order.event?.doorsOpen)}</p>
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <img src="${qrDataUrl}" width="250" height="250" style="border: 2px solid #e5e7eb; border-radius: 8px;" />
            <p style="font-family: monospace; font-size: 12px; color: #999; margin-top: 8px;">${esc(ticket?.qrCode)}</p>
          </div>
          <div style="background: ${brand.colors.emailTint}; border-radius: 8px; padding: 16px;">
            <p style="margin: 4px 0;"><strong>Titular:</strong> ${esc(ticket?.holderName)}</p>
            <p style="margin: 4px 0;"><strong>Tipo:</strong> ${esc(ticket?.ticketType?.name ?? 'General')}</p>
            <p style="margin: 4px 0;"><strong>ID:</strong> ${esc(ticket?.id?.slice(0, 8))}</p>
          </div>
          <p style="text-align: center; font-size: 11px; color: #aaa; margin-top: 20px;">Presenta este c\u00f3digo QR en la entrada del evento. No compartas este c\u00f3digo.</p>
        </div>
      `);
    }

    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Entradas - ${esc(order.event?.name)}</title></head><body style="margin:0;padding:0;">${ticketHtmls.join('')}</body></html>`;

    return new NextResponse(fullHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (error) {
    return handleApiError(error, 'GET /api/tickets/[orderId]/pdf-html');
  }
}
