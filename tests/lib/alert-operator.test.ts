import { beforeEach, describe, expect, it, vi } from 'vitest';

/* OB-02: `alertOperator` avisa por DOS canales independientes (correo del cliente y canal del operador). Con todo simulado: sin BD, SMTP ni red. */

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(async (_p: unknown) => ({ success: true })),
  getOperatorEmail: vi.fn(async (_kind: string): Promise<string> => 'admin@cliente.es'),
  rateLimit: vi.fn(async (_b: string, _k: string, _l: number, _w: number) => ({ ok: true })),
  resetRateLimit: vi.fn(async (_b: string, _k: string) => {}),
}));
vi.mock('@/lib/mailer', () => ({ sendMail: mocks.sendMail }));
vi.mock('@/lib/config', () => ({ getOperatorEmail: mocks.getOperatorEmail }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.rateLimit, resetRateLimit: mocks.resetRateLimit }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { alertOperator, alertPaidButInactiveOrder, paymentMatchesOrder } from '@/lib/reconciliation/shared';

const ORDER = 'cm9abcdef0123456789zzzzz';
const params = { kind: 'entradas' as const, tag: '[late-payment]', orderId: ORDER, reason: 'refund_failed', subject: 'Asunto', html: '<p>cuerpo con ana@correo.es</p>', dedupeKey: `k:${ORDER}` };

let platform: ReturnType<typeof vi.fn>;
const sentToPlatform = () => platform.mock.calls.map((c) => ({ url: c[0] as string, init: c[1] as RequestInit }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendMail.mockImplementation(async () => ({ success: true }));
  mocks.getOperatorEmail.mockImplementation(async () => 'admin@cliente.es');
  mocks.rateLimit.mockImplementation(async () => ({ ok: true }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  platform = vi.fn(async (_u: string, _i?: RequestInit) => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', platform);
  vi.stubEnv('PLATFORM_ALERT_URL', 'https://ntfy.sh/tema-de-prueba');
  vi.stubEnv('PLATFORM_ALERT_TOKEN', '');
});

describe('alertOperator: dos canales independientes', () => {
  it('los dos canales salen: correo al cliente y alerta al operador', async () => {
    await alertOperator(params);
    expect(mocks.sendMail).toHaveBeenCalledWith({ to: 'admin@cliente.es', subject: 'Asunto', html: params.html });
    expect(sentToPlatform()).toHaveLength(1);
    expect(sentToPlatform()[0].url).toBe('https://ntfy.sh/tema-de-prueba');
  });

  it('sin `admin_email` el canal del operador sale igualmente (y no hay correo)', async () => {
    mocks.getOperatorEmail.mockImplementation(async () => '');
    await alertOperator(params);
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(sentToPlatform()).toHaveLength(1);
  });

  it('si el SMTP del cliente falla (rechaza o lanza), el canal del operador sale igualmente', async () => {
    mocks.sendMail.mockImplementation(async () => {
      throw new Error('SMTP caído: 535 credenciales ana@correo.es');
    });
    await expect(alertOperator(params)).resolves.toBeUndefined();
    expect(sentToPlatform()).toHaveLength(1);

    mocks.sendMail.mockImplementation(async () => ({ success: false, error: 'No hay SMTP configurado' }) as never);
    await expect(alertOperator({ ...params, dedupeKey: 'otra' })).resolves.toBeUndefined();
    expect(sentToPlatform()).toHaveLength(2);
  });

  it('si el canal del operador falla (500, red caída o tiempo), el correo sale igualmente y no se lanza', async () => {
    platform.mockImplementation(async () => new Response('no', { status: 500 }));
    await expect(alertOperator(params)).resolves.toBeUndefined();
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);

    platform.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(alertOperator({ ...params, dedupeKey: 'otra' })).resolves.toBeUndefined();
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
  });

  it('si fallan los dos canales no se lanza nada y queda el log', async () => {
    mocks.sendMail.mockImplementation(async () => {
      throw new Error('smtp');
    });
    platform.mockImplementation(async () => new Response('no', { status: 503 }));
    const log = vi.spyOn(console, 'error');
    await expect(alertOperator(params)).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join(' ')).toContain('[late-payment]');
  });

  it('sin PLATFORM_ALERT_URL el comportamiento es el de siempre: solo el correo, y fetch no se toca', async () => {
    vi.stubEnv('PLATFORM_ALERT_URL', '');
    await alertOperator(params);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(platform).not.toHaveBeenCalled();
  });

  it('el canal del operador se intenta incluso si buscar el correo del cliente lanza (BD de configuración caída)', async () => {
    mocks.getOperatorEmail.mockImplementation(async () => {
      throw new Error('BD caída');
    });
    await expect(alertOperator(params)).resolves.toBeUndefined();
    expect(sentToPlatform()).toHaveLength(1);
  });
});

describe('dedupeKey: un aviso por clave y día, en los dos canales', () => {
  it('con el límite agotado no sale ni el correo ni la alerta', async () => {
    mocks.rateLimit.mockImplementation(async () => ({ ok: false }));
    await alertOperator(params);
    expect(mocks.rateLimit).toHaveBeenCalledWith('operator-alert', params.dedupeKey, 1, 24 * 60 * 60 * 1000);
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(platform).not.toHaveBeenCalled();
  });

  it('dos llamadas con la misma clave: solo la primera avisa', async () => {
    const seen = new Set<string>();
    mocks.rateLimit.mockImplementation(async (_b, key) => ({ ok: !seen.has(key) && !!seen.add(key) }));
    await alertOperator(params);
    await alertOperator(params);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(platform).toHaveBeenCalledTimes(1);
  });

  it('si la consulta del límite falla se avisa igualmente (mejor repetido que perdido)', async () => {
    mocks.rateLimit.mockImplementation(async () => {
      throw new Error('BD caída');
    });
    await alertOperator(params);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(platform).toHaveBeenCalledTimes(1);
  });

  // H-116: el cupo se toma ANTES de enviar; si ningún canal entrega, se devuelve para que el cron (cada 5 min) pueda volver a avisar.
  it('si NINGÚN canal entrega (SMTP caído y canal del operador caído), devuelve el cupo de 24 h', async () => {
    mocks.sendMail.mockImplementation(async () => ({ success: false, error: 'smtp caído' }) as never);
    platform.mockImplementation(async () => new Response('no', { status: 503 }));
    await alertOperator(params);
    expect(mocks.resetRateLimit).toHaveBeenCalledWith('operator-alert', params.dedupeKey);
  });

  it('si al menos un canal entrega, el cupo se queda gastado (un aviso al día)', async () => {
    mocks.sendMail.mockImplementation(async () => ({ success: false, error: 'smtp caído' }) as never);
    await alertOperator(params); // el canal del operador (ntfy simulado) responde 200
    expect(mocks.resetRateLimit).not.toHaveBeenCalled();

    platform.mockImplementation(async () => new Response('no', { status: 500 }));
    mocks.sendMail.mockImplementation(async () => ({ success: true }));
    await alertOperator({ ...params, dedupeKey: 'otra' }); // ahora entrega el correo
    expect(mocks.resetRateLimit).not.toHaveBeenCalled();
  });

  it('sin dedupeKey no se consulta ningún límite', async () => {
    await alertOperator({ ...params, dedupeKey: undefined });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(platform).toHaveBeenCalledTimes(1);
  });
});

describe('contenido de la alerta del operador', () => {
  it('lleva severidad, tipo, motivo y el pedido TRUNCADO; nada del cuerpo del correo (comprador, importes, URLs)', async () => {
    await alertOperator({ ...params, details: { detail: 'rechazado para ana@correo.es', amount: 25 } });
    const { init } = sentToPlatform()[0];
    const body = String(init.body);
    expect(body).toContain('FALLO entradas: refund_failed');
    expect(body).toContain('Pedido: cm9abcde');
    expect(body).not.toContain(ORDER);
    expect(body).not.toMatch(/ana@|correo\.es|cuerpo|Asunto|25|https?:/);
    expect(JSON.stringify(init.headers)).not.toMatch(/ana@/);
  });

  it('un motivo meramente informativo sale como aviso', async () => {
    await alertOperator({ ...params, reason: 'refunded_no_capacity', dedupeKey: undefined });
    expect(String(sentToPlatform()[0].init.body)).toContain('AVISO');
  });
});

describe('las alertas de dinero que no pasaban por alertOperator ahora también salen por los dos canales', () => {
  it('pago sobre pedido ya anulado (alertPaidButInactiveOrder)', async () => {
    await alertPaidButInactiveOrder('tienda', ORDER, 'REFUNDED');
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(String(sentToPlatform()[0].init.body)).toContain('paid_but_inactive');
  });

  it('importe que no cuadra (paymentMatchesOrder): no completa el pedido, y avisa por los dos canales una vez al día', async () => {
    const { prisma } = await import('@/lib/prisma');
    (prisma as unknown as Record<string, unknown>).order = { findUnique: vi.fn(async () => ({ totalAmount: 25 })) };
    expect(await paymentMatchesOrder('entradas', ORDER, { amount: 1, currency: 'EUR' })).toBe(false);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail.mock.calls[0][0]).toMatchObject({ to: 'admin@cliente.es', subject: expect.stringContaining('no cuadra') });
    expect(String(sentToPlatform()[0].init.body)).toContain('amount_mismatch');
    expect(String(sentToPlatform()[0].init.body)).not.toMatch(/\b25\b|\b1\b EUR/); // sin importes
    expect(mocks.rateLimit).toHaveBeenCalledWith('operator-alert', `amount-mismatch:${ORDER}`, 1, 24 * 60 * 60 * 1000);
    // cuadra → no avisa
    mocks.sendMail.mockClear();
    platform.mockClear();
    expect(await paymentMatchesOrder('entradas', ORDER, { amount: 25, currency: 'EUR' })).toBe(true);
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(platform).not.toHaveBeenCalled();
  });
});
