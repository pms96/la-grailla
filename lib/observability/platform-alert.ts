import { isPlatformMode } from '@/lib/tenant/mode';
import { safeTenantId } from './capture';
import { truncateId } from './scrub';

/* Canal de alertas del OPERADOR DE LA PLATAFORMA, independiente del SMTP del cliente (OB-02 / P0-07). Hasta ahora un aviso de dinero salía solo
 * por correo, con el SMTP del cliente y a su `admin_email`: si el SMTP falla o no hay `admin_email`, el aviso se perdía. Este canal sale por HTTP
 * directo a un tema de ntfy (o un webhook compatible: Slack, Discord, JSON genérico) del operador.
 *
 *  - `PLATFORM_ALERT_URL`    URL https del tema/webhook. Lleva el nombre del tema (ntfy) o un token (Slack): es un SECRETO, no se registra.
 *  - `PLATFORM_ALERT_TOKEN`  opcional: se envía como `Authorization: Bearer` (ntfy con control de acceso, webhooks propios).
 * Sin `PLATFORM_ALERT_URL` no hace nada. Mismo formato y misma disciplina que las alertas del panel (apps/control-panel/lib/services/alerts.ts):
 * un solo intento, tiempo máximo de pocos segundos, sin seguir redirecciones, nunca lanza, y los errores se anotan SIN el mensaje (podría llevar la URL).
 *
 * Contenido: severidad, cliente (id, nunca su Host ni el nombre del negocio), tipo, motivo y el id de pedido truncado a 8 caracteres. NUNCA datos
 * del comprador, importes ni URLs firmadas: aquí no llegan (la firma de la función no los admite). */

export type PlatformAlertSeverity = 'critical' | 'warning';
export type PlatformAlert = {
  severity?: PlatformAlertSeverity;
  /** `entradas` o `tienda`. */
  kind: string;
  /** Motivo corto en snake_case (`paid_but_inactive`, `refund_failed`…). */
  reason: string;
  orderId?: string;
};
export type PlatformAlertResult = 'disabled' | 'sent' | 'failed';
export type PlatformAlertDeps = { env?: NodeJS.ProcessEnv; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>; tenantId?: string | null };

export const PLATFORM_ALERT_TIMEOUT_MS = 4_000;

/** Motivos que solo informan (no exigen actuar ya): salen como aviso, no como fallo. El resto toca dinero sin resolver y sale como fallo. */
const INFO_REASONS = new Set(['refunded_no_capacity', 'refunded_in_gateway', 'stuck_processing']);
export const severityForReason = (reason: string): PlatformAlertSeverity => (INFO_REASONS.has(reason) ? 'warning' : 'critical');

export function platformAlertConfig(env: NodeJS.ProcessEnv = process.env): { url: string; token: string | null } | null {
  const raw = env.PLATFORM_ALERT_URL?.trim();
  if (!raw) return null;
  try {
    if (new URL(raw).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { url: raw, token: env.PLATFORM_ALERT_TOKEN?.trim() || null };
}

/** Solo letras, cifras y `_ : -`: ni un texto libre ni un dato personal puede colarse por `kind` o `reason`. */
const slug = (v: string, max = 60) => v.replace(/[^A-Za-z0-9_:-]/g, '').slice(0, max);

const LABEL: Record<PlatformAlertSeverity, string> = { critical: '🔴 FALLO', warning: '🟠 AVISO' };
/** Cabeceras HTTP solo admiten latin-1: se quitan los emojis (los acentos españoles sí caben). */
const headerSafe = (s: string) => s.replace(/[^\x20-\xFF]/g, '').trim();

/** Qué se envía (puro, para poder probarlo): mismo reparto por servicio que el panel (ntfy texto plano con cabeceras, Slack `text`, Discord `content`, JSON genérico). */
export function platformAlertRequest(
  url: string,
  token: string | null,
  alert: Required<Pick<PlatformAlert, 'kind' | 'reason'>> & { severity: PlatformAlertSeverity; orderId?: string },
  tenant: string,
  now: Date = new Date()
): { headers: Record<string, string>; body: string } {
  const kind = slug(alert.kind, 20);
  const reason = slug(alert.reason);
  const order = truncateId(alert.orderId);
  const title = `${LABEL[alert.severity]} ${kind}: ${reason}`;
  const text = [title, `Cliente: ${tenant}`, `Tipo: ${kind}`, `Motivo: ${reason}`, ...(order ? [`Pedido: ${order}`] : [])].join('\n');
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const host = new URL(url).hostname;
  if (host === 'ntfy.sh' || host.endsWith('.ntfy.sh') || host.startsWith('ntfy.')) {
    const priority = alert.severity === 'critical' ? 'high' : 'default';
    const tags = alert.severity === 'critical' ? 'rotating_light' : 'warning';
    return { headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: headerSafe(title), Priority: priority, Tags: tags, ...auth }, body: text };
  }
  if (host === 'hooks.slack.com') return { headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ text }) };
  if (host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com') {
    return { headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ content: text }) };
  }
  return {
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ text, content: text, severity: alert.severity, title, tenant, kind, reason, order: order || null, at: now.toISOString() }),
  };
}

/** Envía la alerta al canal del operador. No hace nada sin `PLATFORM_ALERT_URL`. Nunca lanza. */
export async function sendPlatformAlert(alert: PlatformAlert, deps: PlatformAlertDeps = {}): Promise<PlatformAlertResult> {
  const cfg = platformAlertConfig(deps.env ?? process.env);
  if (!cfg) return 'disabled';
  try {
    const tenant = deps.tenantId !== undefined ? deps.tenantId : safeTenantId();
    // Sin id de cliente: instalación única (proyecto antiguo) o tarea sin contexto. Se dice cuál, para distinguirlo en el móvil.
    const label = tenant ?? (isPlatformMode() ? '-' : 'instalacion-unica');
    const severity = alert.severity ?? severityForReason(alert.reason);
    const { headers, body } = platformAlertRequest(cfg.url, cfg.token, { ...alert, severity }, label);
    const res = await (deps.fetchImpl ?? fetch)(cfg.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(PLATFORM_ALERT_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return 'sent';
  } catch (err) {
    // Sin el mensaje de error: podría llevar la URL del canal, que es un secreto.
    console.error(`[platform-alert] el canal del operador falló (${err instanceof Error ? err.name : 'error'})`);
    return 'failed';
  }
}
