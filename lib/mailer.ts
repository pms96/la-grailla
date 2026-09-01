import { getConfigs } from '@/lib/config';

// Cualquier dato de un tercero (nombre de comprador, mensaje de un
// formulario) que acabe interpolado en el HTML de un email debe pasar por
// aquí — sin escapar, ese texto podría llevar HTML/enlaces manipulados.
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type MailAttachment = { filename: string; content: Buffer; contentType?: string };

export type SendMailParams = {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  attachments?: MailAttachment[];
};

export type SendMailResult = { success: boolean; transport: 'smtp' | 'none'; error?: string };

export async function getSmtpSettings() {
  const cfg = await getConfigs([
    'smtp_enabled',
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_password',
    'smtp_secure',
    'smtp_from_email',
    'smtp_from_name',
  ]);
  return {
    enabled: cfg.smtp_enabled === 'true',
    host: cfg.smtp_host,
    port: parseInt(cfg.smtp_port || '587', 10),
    user: cfg.smtp_user,
    password: cfg.smtp_password,
    secure: cfg.smtp_secure === 'true',
    fromEmail: cfg.smtp_from_email,
    fromName: cfg.smtp_from_name || 'La Grailla',
  };
}

export async function sendMail(params: SendMailParams): Promise<SendMailResult> {
  let smtp: Awaited<ReturnType<typeof getSmtpSettings>> | null = null;
  try {
    smtp = await getSmtpSettings();
  } catch {
    smtp = null;
  }

  if (smtp?.enabled && smtp.host && smtp.user) {
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure || smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.password },
      });
      const info = await transporter.sendMail({
        from: '"' + smtp.fromName + '" <' + (smtp.fromEmail || smtp.user) + '>',
        to: params.to,
        subject: params.subject,
        html: params.html,
        replyTo: params.replyTo,
        attachments: params.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      if (info.rejected?.length) {
        console.error('SMTP rejected recipient(s):', info.rejected.join(', '), '-', info.response);
        return { success: false, transport: 'none', error: `Rechazado por el servidor: ${info.rejected.join(', ')}` };
      }
      return { success: true, transport: 'smtp' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('SMTP send failed:', message);
      return { success: false, transport: 'none', error: message };
    }
  }

  return { success: false, transport: 'none', error: 'No hay SMTP configurado' };
}
