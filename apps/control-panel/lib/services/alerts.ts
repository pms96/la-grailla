import { redactUrls } from '../migrations/executor';
import { mailerConfig, smtpMailer, type Mailer } from './mailer';

/* Alertas del panel: avisan al operador cuando algo falla y cuando se recupera. Sin tablas ni estado propio: el aviso sale en el MOMENTO del
 * cambio (una tarea llega a N fallos seguidos, un cliente pasa de sano a degradado, una migración falla…), así que un problema que dura
 * horas no repite el mensaje cada 5 minutos.
 *
 * Canales (todos opcionales; sin ninguno, el aviso solo queda en el log de Vercel):
 *  - `ALERT_WEBHOOK_URL`  ntfy (móvil, sin cuenta), Slack, Discord o cualquier URL que acepte JSON. La URL lleva un token: es un SECRETO.
 *  - `ALERT_EMAIL_TO`     direcciones separadas por comas; sale por el SMTP del panel (`PANEL_SMTP_*`, ver mailer.ts).
 *  - `HEARTBEAT_URL`      «latido»: cada pasada del disparador hace un GET a esta URL (healthchecks.io, Better Stack…). Si el panel o el cron
 *                         dejan de funcionar, ese servicio externo avisa por su cuenta: es lo único que cubre la caída del propio panel.
 * Un aviso nunca lanza: si un canal falla se anota en el log y se sigue. Nada de lo que se envía lleva URLs de BD ni secretos. */

export type AlertSeverity = 'critical' | 'warning' | 'recovery' | 'test';
export type Alert = { severity: AlertSeverity; title: string; detail?: string; tenant?: { name: string; host?: string } };

export type AlertConfig = { webhookUrl: string | null; emailTo: string[]; heartbeatUrl: string | null };

const httpsUrl = (v: string | undefined): string | null => {
  const s = v?.trim();
  if (!s) return null;
  try {
    return new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
};

export function alertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  return {
    webhookUrl: httpsUrl(env.ALERT_WEBHOOK_URL),
    emailTo: (env.ALERT_EMAIL_TO ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
    heartbeatUrl: httpsUrl(env.HEARTBEAT_URL),
  };
}

/** Qué canales hay configurados (sin mostrar ninguna URL ni dirección). El correo exige además el SMTP del panel. */
export function describeChannels(env: NodeJS.ProcessEnv = process.env): { webhook: boolean; email: boolean; heartbeat: boolean; emailNeedsSmtp: boolean } {
  const cfg = alertConfig(env);
  const smtp = mailerConfig(env) !== null;
  return { webhook: cfg.webhookUrl !== null, email: cfg.emailTo.length > 0 && smtp, heartbeat: cfg.heartbeatUrl !== null, emailNeedsSmtp: cfg.emailTo.length > 0 && !smtp };
}

const LABEL: Record<AlertSeverity, string> = { critical: '🔴 FALLO', warning: '🟠 AVISO', recovery: '🟢 RECUPERADO', test: '🔔 PRUEBA' };

/** Una línea sin saltos y sin URLs de conexión; lo que se envía por fuera nunca lleva más que esto. */
const clean = (s: string | undefined, max = 400) => redactUrls(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function alertText(a: Alert): string {
  const lines = [`${LABEL[a.severity]} ${clean(a.title, 200)}`];
  if (a.tenant) lines.push(`Cliente: ${clean(a.tenant.name, 80)}${a.tenant.host ? ` (${clean(a.tenant.host, 120)})` : ''}`);
  if (a.detail) lines.push(clean(a.detail));
  return lines.join('\n');
}

/** Cabeceras HTTP solo admiten latin-1: se quitan emojis y símbolos fuera de ese rango (los acentos españoles sí caben). */
const headerSafe = (s: string) => s.replace(/[^\x20-\xFF]/g, '').trim();

/** Cada servicio espera un formato distinto: ntfy un texto plano con cabeceras, Slack `text`, Discord `content`, el resto un JSON genérico. */
export function webhookRequest(url: string, a: Alert, now: Date = new Date()): { headers: Record<string, string>; body: string } {
  const host = new URL(url).hostname;
  const text = alertText(a);
  if (host === 'ntfy.sh' || host.endsWith('.ntfy.sh') || host.startsWith('ntfy.')) {
    const priority = { critical: 'high', warning: 'default', recovery: 'low', test: 'default' }[a.severity];
    const tags = { critical: 'rotating_light', warning: 'warning', recovery: 'white_check_mark', test: 'bell' }[a.severity];
    return { headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: headerSafe(clean(a.title, 120)), Priority: priority, Tags: tags }, body: text };
  }
  if (host === 'hooks.slack.com') return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) };
  if (host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com') {
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) };
  }
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text, severity: a.severity, title: clean(a.title, 200), tenant: a.tenant?.name ?? null, host: a.tenant?.host ?? null, detail: clean(a.detail), at: now.toISOString() }),
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type NotifyDeps = { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; /** `null` = sin correo a propósito; `undefined` = el del entorno. */ mailer?: Mailer | null; now?: () => Date };
export type NotifyResult = { sent: string[]; failed: string[] };

const TIMEOUT_MS = 8_000;

/** Envía el aviso por todos los canales configurados. No lanza nunca. */
export async function notify(alert: Alert, deps: NotifyDeps = {}): Promise<NotifyResult> {
  const env = deps.env ?? process.env;
  const cfg = alertConfig(env);
  const result: NotifyResult = { sent: [], failed: [] };
  // En el log de Vercel siempre, aunque no haya canales: es el historial mínimo.
  const logLine = `[alert] ${alert.severity} ${clean(alert.title, 200)}${alert.tenant ? ` (${clean(alert.tenant.name, 80)})` : ''}`;
  (alert.severity === 'critical' ? console.error : console.warn)(logLine);

  if (cfg.webhookUrl) {
    try {
      const { headers, body } = webhookRequest(cfg.webhookUrl, alert, deps.now?.());
      const res = await (deps.fetchImpl ?? fetch)(cfg.webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      result.sent.push('webhook');
    } catch (err) {
      // Sin el mensaje de error: podría llevar la URL del webhook, que es un secreto.
      console.error(`[alert] el canal webhook falló (${err instanceof Error ? err.name : 'error'})`);
      result.failed.push('webhook');
    }
  }

  if (cfg.emailTo.length) {
    const mailer = deps.mailer === undefined ? (() => { const m = mailerConfig(env); return m ? smtpMailer(m) : null; })() : deps.mailer;
    if (!mailer) {
      console.error('[alert] ALERT_EMAIL_TO está puesto pero el panel no tiene SMTP configurado (PANEL_SMTP_*)');
      result.failed.push('email');
    } else {
      try {
        const text = alertText(alert);
        const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await mailer({ to: cfg.emailTo.join(', '), subject: `[La Grailla] ${clean(alert.title, 120)}`, text, html: `<pre style="font-family:Arial,Helvetica,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text)}</pre>` });
        result.sent.push('email');
      } catch (err) {
        console.error(`[alert] el canal de correo falló (${err instanceof Error ? err.name : 'error'})`);
        result.failed.push('email');
      }
    }
  }
  return result;
}

/** «Latido» del disparador: GET a `HEARTBEAT_URL` (y a `/fail` si la pasada reventó). Devuelve si se envió. No lanza nunca. */
export async function sendHeartbeat(ok: boolean, deps: Pick<NotifyDeps, 'env' | 'fetchImpl'> = {}): Promise<boolean> {
  const url = alertConfig(deps.env ?? process.env).heartbeatUrl;
  if (!url) return false;
  try {
    const target = ok ? url : `${url.replace(/\/+$/, '')}/fail`;
    const res = await (deps.fetchImpl ?? fetch)(target, { method: 'GET', signal: AbortSignal.timeout(5_000), redirect: 'error' });
    return res.ok;
  } catch (err) {
    console.error(`[alert] el latido no se pudo enviar (${err instanceof Error ? err.name : 'error'})`);
    return false;
  }
}
