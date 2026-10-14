import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alertConfig, alertText, describeChannels, notify, sendHeartbeat, webhookRequest, type Alert } from '@/lib/services/alerts';
import type { OutgoingMail } from '@/lib/services/mailer';

const NTFY = 'https://ntfy.sh/grailla-alertas-secreto-123';
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXX-secreto';
const DISCORD = 'https://discord.com/api/webhooks/123/token-secreto';
const GENERIC = 'https://alertas.ejemplo.es/hook/token-secreto';

const critical: Alert = { severity: 'critical', title: 'Peña La Grailla: la tarea «health» falla', detail: '2 fallos seguidos. timeout', tenant: { name: 'Peña La Grailla', host: 'www.lagrailla.es' } };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

type Call = { url: string; init: RequestInit };
const recordingFetch = (status = 200) => {
  const calls: Call[] = [];
  return { calls, fetchImpl: async (url: string, init?: RequestInit) => (calls.push({ url, init: init ?? {} }), new Response('ok', { status })) };
};

describe('configuración', () => {
  it('sin variables, no hay canales; las URLs deben ser https y los correos válidos', () => {
    expect(alertConfig({} as NodeJS.ProcessEnv)).toEqual({ webhookUrl: null, emailTo: [], heartbeatUrl: null });
    const cfg = alertConfig({ ALERT_WEBHOOK_URL: ` ${NTFY} `, ALERT_EMAIL_TO: 'a@b.test, no-es-correo ,c@d.test', HEARTBEAT_URL: 'http://inseguro.test/ping' } as unknown as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ webhookUrl: NTFY, emailTo: ['a@b.test', 'c@d.test'], heartbeatUrl: null });
    expect(alertConfig({ ALERT_WEBHOOK_URL: 'no es una url' } as unknown as NodeJS.ProcessEnv).webhookUrl).toBeNull();
  });

  it('describe los canales sin enseñar ninguna URL; el correo exige el SMTP del panel', () => {
    const smtp = { PANEL_SMTP_HOST: 'h', PANEL_SMTP_USER: 'u', PANEL_SMTP_PASSWORD: 'p', PANEL_SMTP_FROM_EMAIL: 'x@y.test' };
    const only = describeChannels({ ALERT_EMAIL_TO: 'a@b.test' } as unknown as NodeJS.ProcessEnv);
    expect(only).toMatchObject({ webhook: false, email: false, emailNeedsSmtp: true });
    const all = describeChannels({ ALERT_WEBHOOK_URL: NTFY, ALERT_EMAIL_TO: 'a@b.test', HEARTBEAT_URL: 'https://hc-ping.com/abc', ...smtp } as unknown as NodeJS.ProcessEnv);
    expect(all).toEqual({ webhook: true, email: true, heartbeat: true, emailNeedsSmtp: false });
    expect(JSON.stringify(all)).not.toMatch(/ntfy|secreto|hc-ping/);
  });
});

describe('el texto del aviso', () => {
  it('lleva gravedad, cliente y detalle, en líneas cortas', () => {
    expect(alertText(critical)).toBe('🔴 FALLO Peña La Grailla: la tarea «health» falla\nCliente: Peña La Grailla (www.lagrailla.es)\n2 fallos seguidos. timeout');
    expect(alertText({ severity: 'recovery', title: 'vuelve' })).toBe('🟢 RECUPERADO vuelve');
  });

  it('nunca deja pasar una URL de conexión ni saltos de línea', () => {
    const t = alertText({ severity: 'critical', title: 'x\r\ny', detail: 'falló postgresql://usuario:clave-secreta@host.neon.tech/db?sslmode=require y siguió' });
    expect(t).not.toMatch(/clave-secreta|usuario:/);
    expect(t).not.toMatch(/\r/);
    expect(t.split('\n')).toHaveLength(2);
  });
});

describe('formato por servicio', () => {
  it('ntfy: texto plano con prioridad, etiquetas y título sin caracteres que no caben en una cabecera', () => {
    const r = webhookRequest(NTFY, { ...critical, title: '🔴 Caída: «health» falla' });
    expect(r.headers).toMatchObject({ Priority: 'high', Tags: 'rotating_light', 'Content-Type': 'text/plain; charset=utf-8' });
    expect(r.headers.Title).toBe('Caída: «health» falla');
    expect(r.body).toContain('Cliente: Peña La Grailla');
    expect(webhookRequest(NTFY, { severity: 'recovery', title: 'ok' }).headers.Priority).toBe('low');
  });

  it('Slack lleva `text`, Discord `content` (con tope de longitud) y el resto un JSON con todo', () => {
    expect(JSON.parse(webhookRequest(SLACK, critical).body)).toEqual({ text: alertText(critical) });
    expect(JSON.parse(webhookRequest(DISCORD, critical).body)).toEqual({ content: alertText(critical) });
    expect(JSON.parse(webhookRequest(DISCORD, { ...critical, detail: 'x'.repeat(5000) }).body).content.length).toBeLessThanOrEqual(1900);
    const generic = JSON.parse(webhookRequest(GENERIC, critical, new Date('2026-10-14T10:00:00Z')).body);
    expect(generic).toMatchObject({ severity: 'critical', tenant: 'Peña La Grailla', host: 'www.lagrailla.es', at: '2026-10-14T10:00:00.000Z' });
    expect(generic.text).toBe(alertText(critical));
  });
});

describe('notify', () => {
  it('sin canales no hace nada más que dejar la línea en el log, y no lanza', async () => {
    expect(await notify(critical, { env: {} as NodeJS.ProcessEnv })).toEqual({ sent: [], failed: [] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[alert] critical'));
  });

  it('envía por el webhook (sin seguir redirecciones) y por correo, cada uno por su lado', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const mails: OutgoingMail[] = [];
    const res = await notify(critical, { env: { ALERT_WEBHOOK_URL: NTFY, ALERT_EMAIL_TO: 'a@b.test,c@d.test' } as unknown as NodeJS.ProcessEnv, fetchImpl, mailer: async (m) => void mails.push(m) });
    expect(res).toEqual({ sent: ['webhook', 'email'], failed: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(NTFY);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');
    expect(mails[0].to).toBe('a@b.test, c@d.test');
    expect(mails[0].subject).toBe('[La Grailla] Peña La Grailla: la tarea «health» falla');
    expect(mails[0].html).not.toContain('<script');
  });

  it('un canal que falla no impide el otro y el motivo no filtra la URL del webhook', async () => {
    const boom = async () => {
      throw new Error(`fetch failed ${NTFY}`);
    };
    const mails: OutgoingMail[] = [];
    const res = await notify(critical, { env: { ALERT_WEBHOOK_URL: NTFY, ALERT_EMAIL_TO: 'a@b.test' } as unknown as NodeJS.ProcessEnv, fetchImpl: boom, mailer: async (m) => void mails.push(m) });
    expect(res).toEqual({ sent: ['email'], failed: ['webhook'] });
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('ntfy.sh');
    expect(logged).not.toContain('secreto');
  });

  it('un webhook que responde con error cuenta como fallo; el correo sin SMTP también', async () => {
    const { fetchImpl } = recordingFetch(500);
    const res = await notify(critical, { env: { ALERT_WEBHOOK_URL: SLACK, ALERT_EMAIL_TO: 'a@b.test' } as unknown as NodeJS.ProcessEnv, fetchImpl, mailer: null });
    expect(res).toEqual({ sent: [], failed: ['webhook', 'email'] });
  });

  it('un correo que revienta no lanza', async () => {
    const res = await notify(critical, { env: { ALERT_EMAIL_TO: 'a@b.test' } as unknown as NodeJS.ProcessEnv, mailer: async () => { throw new Error('535 auth'); } });
    expect(res.failed).toEqual(['email']);
  });
});

describe('latido', () => {
  const env = { HEARTBEAT_URL: 'https://hc-ping.com/abc-secreto/' } as unknown as NodeJS.ProcessEnv;

  it('GET a la URL si todo va bien y a /fail si la pasada reventó', async () => {
    const { calls, fetchImpl } = recordingFetch();
    expect(await sendHeartbeat(true, { env, fetchImpl })).toBe(true);
    expect(await sendHeartbeat(false, { env, fetchImpl })).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['https://hc-ping.com/abc-secreto/', 'https://hc-ping.com/abc-secreto/fail']);
    expect(calls.every((c) => c.init.method === 'GET' && c.init.redirect === 'error')).toBe(true);
  });

  it('sin URL no hace nada, y si falla no lanza ni filtra la URL', async () => {
    const { calls, fetchImpl } = recordingFetch();
    expect(await sendHeartbeat(true, { env: {} as NodeJS.ProcessEnv, fetchImpl })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await sendHeartbeat(true, { env, fetchImpl: async () => { throw new Error('caído hc-ping.com/abc-secreto'); } })).toBe(false);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('secreto');
  });
});
