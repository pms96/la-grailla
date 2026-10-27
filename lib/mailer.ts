import { ConfigReadError, getConfigsOrFail } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';

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

/**
 * `errorCode` distingue QUÉ ha fallado, para que quien reintenta (barrido de emails) y quien diagnostica no confundan «el cliente no ha
 * configurado el SMTP» (hay que avisarle: reintentar no sirve) con «no se pudo leer la configuración» (transitorio) o «el servidor SMTP falló».
 */
export type SendMailErrorCode = 'smtp_not_configured' | 'config_unavailable' | 'smtp_unavailable' | 'smtp_rejected' | 'smtp_failed';

/**
 * Códigos de error de nodemailer que significan «el SERVIDOR de correo no está disponible o no nos deja entrar» (conexión, DNS, tiempo, TLS, credenciales):
 * un fallo SISTÉMICO que afecta a todos los pedidos por igual y se arregla en la configuración, no un problema del destinatario.
 */
const SYSTEMIC_SMTP_CODES = new Set(['ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'ETLS', 'EAUTH', 'EPROTOCOL']);
/** `EENVELOPE`: el servidor rechaza a un destinatario (buzón inexistente, dirección mal escrita): permanente para ESE pedido. */
export function classifySmtpError(error: unknown): 'smtp_unavailable' | 'smtp_rejected' | 'smtp_failed' {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
  if (code === 'EENVELOPE') return 'smtp_rejected';
  return SYSTEMIC_SMTP_CODES.has(code) ? 'smtp_unavailable' : 'smtp_failed';
}
export type SendMailResult = { success: boolean; transport: 'smtp' | 'none'; error?: string; errorCode?: SendMailErrorCode };

/** Tiempos máximos del SMTP del cliente: sin ellos, un servidor colgado retiene la función hasta el límite de la plataforma (nodemailer espera minutos). */
export const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, dnsTimeout: 10_000 } as const;

/**
 * Mensaje de error de envío SEGURO para guardarlo y mostrarlo: sin credenciales (usuario/contraseña del SMTP si aparecieran en el texto)
 * ni direcciones de correo (el comprador), con el código de nodemailer por delante y una longitud acotada.
 */
export function describeMailError(error: unknown, secrets: (string | undefined)[] = []): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? String((error as { code: string }).code) : '';
  let text = raw;
  for (const secret of secrets) {
    if (secret && secret.length >= 3) text = text.split(secret).join('***');
  }
  text = text
    .replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim();
  const message = (code && !text.startsWith(code) ? `${code}: ${text}` : text).slice(0, 160);
  return message || 'Error desconocido al enviar';
}

export async function getSmtpSettings() {
  const cfg = await getConfigsOrFail([
    'smtp_enabled',
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_password',
    'smtp_secure',
    'smtp_from_email',
    'smtp_from_name',
  ]);
  // Sin nombre de remitente configurado, el de la marca del cliente (nunca el de otro).
  // Sin comillas ni saltos de línea: el nombre va entre comillas en la cabecera From.
  const fromName = (cfg.smtp_from_name || (await getBrand().then((b) => b.name).catch(() => ''))).replace(/["\r\n]/g, '');
  return {
    enabled: cfg.smtp_enabled === 'true',
    host: cfg.smtp_host,
    port: parseInt(cfg.smtp_port || '587', 10),
    user: cfg.smtp_user,
    password: cfg.smtp_password,
    secure: cfg.smtp_secure === 'true',
    fromEmail: cfg.smtp_from_email,
    fromName,
  };
}

export async function sendMail(params: SendMailParams): Promise<SendMailResult> {
  let smtp: Awaited<ReturnType<typeof getSmtpSettings>>;
  try {
    smtp = await getSmtpSettings();
  } catch (error) {
    // OB-07: un fallo de la BD al leer la configuración NO es «no hay SMTP»: se dice tal cual (transitorio, reintentable) y no se culpa al cliente.
    if (error instanceof ConfigReadError) {
      return { success: false, transport: 'none', error: 'config_unavailable: no se pudo leer la configuración del correo', errorCode: 'config_unavailable' };
    }
    console.error('SMTP settings failed:', describeMailError(error));
    return { success: false, transport: 'none', error: `config_unavailable: ${describeMailError(error)}`, errorCode: 'config_unavailable' };
  }

  if (smtp.enabled && smtp.host && smtp.user) {
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure || smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.password },
        ...SMTP_TIMEOUTS,
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
        // Sin las direcciones en el mensaje: acaba guardado y en pantallas, y es el correo del comprador.
        console.error('SMTP rejected recipient(s):', info.rejected.length, '-', describeMailError(info.response ?? '', [smtp.user, smtp.password]));
        return { success: false, transport: 'none', error: 'smtp_rejected: el servidor ha rechazado al destinatario', errorCode: 'smtp_rejected' };
      }
      return { success: true, transport: 'smtp' };
    } catch (error) {
      const message = describeMailError(error, [smtp.user, smtp.password]);
      console.error('SMTP send failed:', message);
      return { success: false, transport: 'none', error: message, errorCode: classifySmtpError(error) };
    }
  }

  return { success: false, transport: 'none', error: 'No hay SMTP configurado', errorCode: 'smtp_not_configured' };
}
