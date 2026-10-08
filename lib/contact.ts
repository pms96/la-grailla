import { z } from 'zod';
import { escapeHtml } from '@/lib/html-escape';
import { getBrand } from '@/lib/brand/brand';
import { brandLogoHtml } from '@/lib/brand/email';
import { getFallbackBaseUrl } from '@/lib/url';
import { getConfig } from '@/lib/config';
import { perRequest } from '@/lib/request-cache';

/* Bandeja de contacto (núcleo): validación del formulario público y los emails que genera. */

/** Campo trampa: está oculto para las personas. Si llega relleno, es un bot y se descarta en silencio. */
export const CONTACT_HONEYPOT_FIELD = 'website';

export const contactSchema = z.object({
  name: z.string().trim().min(1, 'Escribe tu nombre').max(120),
  email: z.string().trim().email('Escribe un email válido').max(255),
  phone: z.string().trim().max(30).optional().nullable(),
  subject: z.string().trim().max(150).optional().nullable(),
  message: z.string().trim().min(5, 'Escribe tu mensaje').max(5000),
  // Checkbox obligatorio del formulario público (RGPD): igual que el de patrocinio.
  consentAccepted: z.literal(true, { errorMap: () => ({ message: 'Debes aceptar la política de privacidad para enviar el mensaje' }) }),
  [CONTACT_HONEYPOT_FIELD]: z.string().max(200).optional().nullable(),
});
export type ContactInput = z.infer<typeof contactSchema>;

/** ¿Tiene este cliente encendido el formulario de contacto? (La Grailla parte apagado, el resto encendido.) */
export const isContactFormEnabled = perRequest(async () => (await getConfig('contact_form_enabled')) === 'true');

export const replySchema = z.object({ body: z.string().trim().min(1, 'Escribe la respuesta').max(5000) });

/** Texto plano → HTML seguro, conservando saltos de línea. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/** Aviso al operador de un mensaje nuevo. `replyTo` es la persona que escribe: responder al aviso le responde a ella. */
export async function contactNotificationEmail(m: { name: string; email: string; phone: string | null; subject: string | null; message: string }) {
  const brand = await getBrand();
  const subject = `Nuevo mensaje de contacto${m.subject ? `: ${m.subject}` : ` de ${m.name}`}`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
    `<h2 style="color:${brand.colors.emailAccent};margin:0 0 12px;">Nuevo mensaje de contacto</h2>` +
    `<p style="margin:4px 0;"><strong>De:</strong> ${escapeHtml(m.name)} &lt;${escapeHtml(m.email)}&gt;</p>` +
    (m.phone ? `<p style="margin:4px 0;"><strong>Teléfono:</strong> ${escapeHtml(m.phone)}</p>` : '') +
    (m.subject ? `<p style="margin:4px 0;"><strong>Asunto:</strong> ${escapeHtml(m.subject)}</p>` : '') +
    `<div style="background:${brand.colors.emailTint};border-radius:8px;padding:14px;margin:14px 0;">${textToHtml(m.message)}</div>` +
    `<p style="font-size:12px;color:#888;">Puedes responder desde el panel (Mensajes) o directamente a este email.</p>` +
    `</div>`;
  return { subject, html };
}

/** Respuesta al visitante: el texto del operador, el mensaje original citado y la marca del cliente. */
export async function contactReplyEmail(original: { name: string; subject: string | null; message: string; createdAt: Date }, body: string) {
  const brand = await getBrand();
  const date = original.createdAt.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
  const subject = original.subject ? `Re: ${original.subject}` : `Respuesta a tu mensaje — ${brand.name}`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:8px;">` +
    `<p>Hola ${escapeHtml(original.name)},</p>` +
    `<div>${textToHtml(body)}</div>` +
    `<div style="border-left:3px solid ${brand.colors.emailAccent};margin:24px 0 0;padding:4px 0 4px 12px;color:#666;font-size:13px;">` +
    `<p style="margin:0 0 6px;">El ${escapeHtml(date)} escribiste:</p>${textToHtml(original.message)}</div>` +
    `<p style="margin-top:28px;">${brandLogoHtml(brand, getFallbackBaseUrl(), 28)}</p>` +
    `</div>`;
  return { subject, html };
}
