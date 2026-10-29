import { escapeHtml as esc } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';
import { getFallbackBaseUrl } from '@/lib/url';
import { EVENT_TIMEZONE } from '@/lib/event-time';

/* Emails a los compradores cuando un evento se CANCELA o CAMBIA DE FECHA (auditoría P1-04 / EN-09). Solo construyen el correo: quién lo recibe, cuándo
 * y cuántas veces lo decide lib/event-cancellation.ts. Todo lo que viene de la BD va escapado. */

const formatWhen = (d: Date) =>
  d.toLocaleString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: EVENT_TIMEZONE });

/** Qué le pasa al dinero de este comprador, para decírselo con exactitud. */
export type CancellationMailKind =
  /** Reembolsado ya por la pasarela. */
  | 'refunded'
  /** Pagó y no se ha podido reembolsar solo (error de la pasarela, entradas ya usadas, otro método de pago): lo gestiona el organizador. */
  | 'manual'
  /** Pedido gratuito: no hay nada que devolver. */
  | 'free';

export interface CancellationMailInput {
  buyerName: string;
  eventName: string;
  eventDate: Date;
  kind: CancellationMailKind;
  /** Total del pedido en euros (para decir cuánto se ha devuelto). */
  amount: number;
  /** Dirección a la que escribir (la del operador del cliente), si la hay. */
  contactEmail: string | null;
}

function shell(brandName: string, accent: string, logo: string, title: string, body: string): string {
  return (
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:8px;">` +
    `<p style="margin:0 0 16px;">${logo}</p>` +
    `<h2 style="color:${accent};margin:0 0 12px;">${esc(title)}</h2>` +
    body +
    `<p style="margin-top:28px;font-size:12px;color:#888;">${esc(brandName)}</p>` +
    `</div>`
  );
}

export async function eventCancelledEmail(input: CancellationMailInput): Promise<{ subject: string; html: string }> {
  const brand = await getBrand();
  const logo = brandLogoHtml(brand, getFallbackBaseUrl(), 28);
  const amount = input.amount.toFixed(2).replace('.', ',');
  const money =
    input.kind === 'refunded'
      ? `<p>Hemos devuelto <strong>${esc(amount)} €</strong> al mismo método de pago con el que compraste. Suele tardar entre 5 y 10 días hábiles en verse en tu cuenta, según tu banco.</p>`
      : input.kind === 'manual'
      ? `<p>Tu pago de <strong>${esc(amount)} €</strong> está pendiente de devolución: lo gestiona el organizador y se pondrá en contacto contigo. ${
          input.contactEmail ? `Si tienes dudas, escríbenos a <a href="mailto:${esc(input.contactEmail)}">${esc(input.contactEmail)}</a>.` : 'Responde a este correo si tienes dudas.'
        }</p>`
      : `<p>Tu pedido era gratuito, así que no hay nada que devolver.</p>`;
  const html = shell(
    brand.name,
    brand.colors.emailAccent,
    logo,
    'Evento cancelado',
    `<p>Hola ${esc(input.buyerName)},</p>` +
      `<p>Lamentamos avisarte de que <strong>${esc(input.eventName)}</strong>, previsto para el ${esc(formatWhen(input.eventDate))}, se ha cancelado. Tus entradas ya no son válidas.</p>` +
      money
  );
  return { subject: `Evento cancelado: ${input.eventName}`, html };
}

export interface DateChangeMailInput {
  buyerName: string;
  eventName: string;
  oldDate: Date;
  newDate: Date;
  contactEmail: string | null;
}

export async function eventDateChangedEmail(input: DateChangeMailInput): Promise<{ subject: string; html: string }> {
  const brand = await getBrand();
  const logo = brandLogoHtml(brand, getFallbackBaseUrl(), 28);
  const html = shell(
    brand.name,
    brand.colors.emailAccent,
    logo,
    'Cambio de fecha',
    `<p>Hola ${esc(input.buyerName)},</p>` +
      `<p>El evento <strong>${esc(input.eventName)}</strong> cambia de fecha.</p>` +
      `<p style="margin:4px 0;"><strong>Antes:</strong> ${esc(formatWhen(input.oldDate))}</p>` +
      `<p style="margin:4px 0;"><strong>Ahora:</strong> ${esc(formatWhen(input.newDate))}</p>` +
      `<p>Tus entradas siguen siendo válidas para la nueva fecha: no tienes que hacer nada. Si ya no puedes asistir, ${
        input.contactEmail ? `escríbenos a <a href="mailto:${esc(input.contactEmail)}">${esc(input.contactEmail)}</a>` : 'responde a este correo'
      } y lo vemos.</p>` +
      `<p style="font-size:13px;color:#666;">Los PDF y pases de Wallet que ya descargaste pueden mostrar la fecha anterior; la entrada (el código QR) es la misma.</p>`
  );
  return { subject: `Cambio de fecha: ${input.eventName}`, html };
}
