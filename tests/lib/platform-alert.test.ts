import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_ALERT_TIMEOUT_MS, platformAlertConfig, platformAlertRequest, sendPlatformAlert, severityForReason } from '@/lib/observability/platform-alert';

/* P0-07 / OB-02: canal de alertas del operador, independiente del SMTP del cliente. Con `fetch` simulado: nunca sale nada a la red. */

const NTFY = 'https://ntfy.sh/tema-secreto-de-prueba';
const env = (over: Record<string, string | undefined> = {}) => ({ PLATFORM_ALERT_URL: NTFY, ...over }) as unknown as NodeJS.ProcessEnv;
const ORDER = 'cm9zzzzzzzzzzzzzzzzzzzzzz';
const ok = async () => new Response('ok', { status: 200 });

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('configuración', () => {
  it('sin URL (o vacía) no hay canal', () => {
    expect(platformAlertConfig({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(platformAlertConfig(env({ PLATFORM_ALERT_URL: '  ' }))).toBeNull();
  });
  it('solo https: una URL http o ilegible se ignora', () => {
    expect(platformAlertConfig(env({ PLATFORM_ALERT_URL: 'http://ntfy.sh/x' }))).toBeNull();
    expect(platformAlertConfig(env({ PLATFORM_ALERT_URL: 'no es una url' }))).toBeNull();
  });
  it('lee el token opcional', () => {
    expect(platformAlertConfig(env())).toEqual({ url: NTFY, token: null });
    expect(platformAlertConfig(env({ PLATFORM_ALERT_TOKEN: ' tk_123 ' }))).toEqual({ url: NTFY, token: 'tk_123' });
  });
});

describe('severidad por motivo', () => {
  it('lo que informa sale como aviso; lo que toca dinero sin resolver, como fallo', () => {
    expect(severityForReason('refunded_no_capacity')).toBe('warning');
    expect(severityForReason('refunded_in_gateway')).toBe('warning');
    for (const r of ['refund_failed', 'paid_but_inactive', 'amount_mismatch', 'stuck_unknown', 'payment_refunded_on_pending_order', 'algo_nuevo']) expect(severityForReason(r)).toBe('critical');
  });
});

describe('formato (el mismo reparto por servicio que el panel)', () => {
  const alert = { kind: 'entradas', reason: 'paid_but_inactive', orderId: ORDER, severity: 'critical' as const };

  it('ntfy: texto plano con Title/Priority/Tags (sin emojis en la cabecera) y Bearer si hay token', () => {
    const r = platformAlertRequest(NTFY, 'tk_123', alert, '01JTENANT');
    expect(r.headers).toMatchObject({ 'Content-Type': 'text/plain; charset=utf-8', Title: 'FALLO entradas: paid_but_inactive', Priority: 'high', Tags: 'rotating_light', Authorization: 'Bearer tk_123' });
    expect(r.body).toBe('🔴 FALLO entradas: paid_but_inactive\nCliente: 01JTENANT\nTipo: entradas\nMotivo: paid_but_inactive\nPedido: cm9zzzzz');
  });

  it('ntfy sin token: sin cabecera Authorization; aviso = prioridad normal', () => {
    const r = platformAlertRequest(NTFY, null, { ...alert, severity: 'warning' }, 'x');
    expect(r.headers).not.toHaveProperty('Authorization');
    expect(r.headers).toMatchObject({ Priority: 'default', Tags: 'warning' });
    expect(r.body).toContain('🟠 AVISO');
  });

  it('Slack: JSON con `text`; Discord: JSON con `content`', () => {
    expect(JSON.parse(platformAlertRequest('https://hooks.slack.com/services/T/B/X', null, alert, 'x').body)).toMatchObject({ text: expect.stringContaining('FALLO') });
    expect(JSON.parse(platformAlertRequest('https://discord.com/api/webhooks/1/x', null, alert, 'x').body)).toMatchObject({ content: expect.stringContaining('FALLO') });
  });

  it('webhook genérico: JSON con severidad, cliente, tipo, motivo y pedido truncado', () => {
    const r = platformAlertRequest('https://alertas.ejemplo.es/hook', 'tk', alert, '01JTENANT', new Date('2026-10-27T10:00:00Z'));
    expect(r.headers.Authorization).toBe('Bearer tk');
    expect(JSON.parse(r.body)).toMatchObject({ severity: 'critical', tenant: '01JTENANT', kind: 'entradas', reason: 'paid_but_inactive', order: 'cm9zzzzz', at: '2026-10-27T10:00:00.000Z' });
  });

  it('el pedido va truncado a 8 caracteres y sin pedido no hay línea', () => {
    expect(platformAlertRequest(NTFY, null, alert, 'x').body).not.toContain(ORDER);
    expect(platformAlertRequest(NTFY, null, { ...alert, orderId: undefined }, 'x').body).not.toContain('Pedido:');
  });

  it('kind y reason solo admiten caracteres de un identificador: un texto libre o un dato personal no puede colarse', () => {
    const r = platformAlertRequest(NTFY, null, { kind: 'entradas ana@correo.es', reason: 'fallo de Ana García 612345678', severity: 'critical' }, 'x');
    expect(r.body).not.toMatch(/ana@|García|\s612|Ana /);
  });
});

describe('sendPlatformAlert', () => {
  it('sin PLATFORM_ALERT_URL no hace nada: ni siquiera llama a fetch', async () => {
    const f = vi.fn(ok);
    expect(await sendPlatformAlert({ kind: 'tienda', reason: 'refund_failed' }, { env: {} as unknown as NodeJS.ProcessEnv, fetchImpl: f })).toBe('disabled');
    expect(f).not.toHaveBeenCalled();
  });

  it('éxito: un POST con el formato de ntfy, token, sin seguir redirecciones y con tiempo máximo', async () => {
    const f = vi.fn(ok);
    const res = await sendPlatformAlert({ kind: 'entradas', reason: 'refund_failed', orderId: ORDER }, { env: env({ PLATFORM_ALERT_TOKEN: 'tk_abc' }), fetchImpl: f, tenantId: '01JTENANT' });
    expect(res).toBe('sent');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(NTFY);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk_abc');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(init.body)).toContain('Cliente: 01JTENANT');
    expect(String(init.body)).toContain('Pedido: cm9zzzzz');
    expect(PLATFORM_ALERT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('respuesta 500: falla sin lanzar, sin reintentar y sin la URL en el log', async () => {
    const f = vi.fn(async () => new Response('no', { status: 500 }));
    expect(await sendPlatformAlert({ kind: 'entradas', reason: 'x' }, { env: env(), fetchImpl: f })).toBe('failed');
    expect(f).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).toContain('[platform-alert]');
    expect(logged).not.toContain('tema-secreto-de-prueba');
  });

  it('red caída: falla sin lanzar', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed: https://ntfy.sh/tema-secreto-de-prueba');
    });
    expect(await sendPlatformAlert({ kind: 'entradas', reason: 'x' }, { env: env(), fetchImpl: f })).toBe('failed');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('tema-secreto-de-prueba'); // solo el nombre del error
  });

  it('tiempo agotado: la petición lleva un tiempo máximo corto y, al cumplirse, falla sin lanzar', async () => {
    // `AbortSignal.timeout` no usa los temporizadores simulados: se sustituye por una señal que se cancela enseguida y se comprueba el plazo pedido.
    const asked: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      asked.push(ms);
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), 5);
      return c.signal;
    });
    const f = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))));
    expect(await sendPlatformAlert({ kind: 'entradas', reason: 'x' }, { env: env(), fetchImpl: f })).toBe('failed');
    expect(asked).toEqual([PLATFORM_ALERT_TIMEOUT_MS]);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('TimeoutError');
  });

  it('sin id de cliente indica «instalacion-unica» (proyecto antiguo); en modo plataforma sin contexto, «-»', async () => {
    const body = async () => {
      const f = vi.fn(ok);
      await sendPlatformAlert({ kind: 'entradas', reason: 'x' }, { env: env(), fetchImpl: f });
      return String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    };
    expect(await body()).toContain('Cliente: instalacion-unica');
    process.env.PLATFORM_MODE = 'on';
    try {
      expect(await body()).toContain('Cliente: -');
    } finally {
      delete process.env.PLATFORM_MODE;
    }
  });

  it('ninguna carga contiene datos del comprador, importes ni URLs firmadas (aunque se pasen en el pedido)', async () => {
    const f = vi.fn(ok);
    // La firma de la función no admite más campos; se comprueba además con valores «sucios» en lo único libre.
    await sendPlatformAlert({ kind: 'entradas', reason: 'paid_but_inactive', orderId: `${ORDER}?t=SECRETO` }, { env: env({ PLATFORM_ALERT_TOKEN: 'tk' }), fetchImpl: f, tenantId: '01JTENANT' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.stringify({ body: init.body, headers: { ...(init.headers as object), Authorization: undefined } });
    expect(payload).not.toMatch(/SECRETO|@|https?:|EUR|€|\d+[.,]\d{2}\b/);
    expect(url).toBe(NTFY);
  });
});
