/* Correo del panel (fase 3): solo para las invitaciones a administradores de las webs de los clientes. Es opcional: sin las variables
 * `PANEL_SMTP_*` el panel no envía nada y enseña el enlace de la invitación una sola vez al operador.
 *
 * Ojo con el DPA: el proveedor SMTP que se configure aquí es un SUBENCARGADO más (ve el correo del administrador del cliente y el enlace de
 * la invitación). Es una cuenta del proveedor, no la de ningún cliente: el correo sale con el remitente del proveedor. */

export type MailerConfig = { host: string; port: number; secure: boolean; user: string; password: string; fromEmail: string; fromName: string };
export type OutgoingMail = { to: string; subject: string; html: string; text: string };
export type Mailer = (mail: OutgoingMail) => Promise<void>;

/** Lee la configuración SMTP del entorno; `null` si falta cualquiera de las cuatro obligatorias (función desactivada). */
export function mailerConfig(env: NodeJS.ProcessEnv = process.env): MailerConfig | null {
  const host = env.PANEL_SMTP_HOST?.trim();
  const user = env.PANEL_SMTP_USER?.trim();
  const password = env.PANEL_SMTP_PASSWORD;
  const fromEmail = env.PANEL_SMTP_FROM_EMAIL?.trim();
  if (!host || !user || !password || !fromEmail) return null;
  const port = Number.parseInt(env.PANEL_SMTP_PORT?.trim() || '587', 10);
  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: env.PANEL_SMTP_SECURE?.trim() === 'true' || port === 465,
    user,
    password,
    fromEmail,
    fromName: oneLine(env.PANEL_SMTP_FROM_NAME?.trim() || 'La Grailla'),
  };
}

/** Sin saltos de línea ni comillas: el texto va en una cabecera. */
const oneLine = (v: string) => v.replace(/["\r\n]/g, ' ').trim();

const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function smtpMailer(cfg: MailerConfig): Mailer {
  return async (mail) => {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.password } });
    await transporter.sendMail({ from: `"${cfg.fromName}" <${cfg.fromEmail}>`, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
  };
}

/** El correo de invitación: dice qué es, el botón con el enlace, cuándo caduca y qué hacer si no lo esperabas. */
export function invitationEmail(args: { brandName: string; link: string; expiresAt: Date }): Pick<OutgoingMail, 'subject' | 'html' | 'text'> {
  const brand = oneLine(args.brandName) || 'tu web';
  const until = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(args.expiresAt);
  const subject = `Crea tu contraseña de la administración de ${brand}`;
  const text = [
    `Te han dado acceso a la administración de ${brand}.`,
    '',
    'Crea tu contraseña con este enlace:',
    args.link,
    '',
    `El enlace funciona una sola vez y caduca el ${until}.`,
    'Si no esperabas este correo, ignóralo: sin abrir el enlace no pasa nada.',
  ].join('\n');
  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;color:#1c1b22;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">
<p>Te han dado acceso a la administración de <strong>${escapeHtml(brand)}</strong>.</p>
<p><a href="${escapeHtml(args.link)}" style="display:inline-block;background:#3d2fd5;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Crear mi contraseña</a></p>
<p style="font-size:13px;color:#555">El enlace funciona una sola vez y caduca el ${escapeHtml(until)}.<br>Si el botón no se abre, copia esta dirección en el navegador:<br><span style="word-break:break-all">${escapeHtml(args.link)}</span></p>
<p style="font-size:13px;color:#555">Si no esperabas este correo, ignóralo: sin abrir el enlace no pasa nada.</p>
</body></html>`;
  return { subject, html, text };
}
