import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAndSetConfig, restoreConfig } from '../helpers/fixtures';
import { ConfigReadError, getConfigsOrFail } from '@/lib/config';
import { SMTP_TIMEOUTS, classifySmtpError, describeMailError, sendMail } from '@/lib/mailer';

/* P0-08 / OB-07: el SMTP del cliente con tiempos máximos, y un fallo de la BD al leer su configuración NO se disfraza de «No hay SMTP configurado».
 * Los mensajes de error que acaban guardados y en pantallas no llevan credenciales ni direcciones de correo. */

const mailer = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: mailer.createTransport } }));

const SMTP = { smtp_enabled: 'true', smtp_host: 'smtp.cliente.test', smtp_port: '587', smtp_user: 'usuario@cliente.es', smtp_password: 'contraseña-secreta-123', smtp_secure: 'false', smtp_from_email: 'tienda@cliente.es' };
const params = { to: 'comprador@example.com', subject: 'Hola', html: '<p>hola</p>' };

describe('lib/mailer', () => {
  const originals: Record<string, string | null> = {};

  beforeAll(async () => {
    for (const [k, v] of Object.entries(SMTP)) originals[k] = await getAndSetConfig(k, v);
  });
  afterAll(async () => {
    for (const k of Object.keys(SMTP)) await restoreConfig(k, originals[k]);
  });
  beforeEach(() => {
    mailer.createTransport.mockReset();
    mailer.sendMail.mockReset();
    mailer.createTransport.mockReturnValue({ sendMail: mailer.sendMail });
    mailer.sendMail.mockResolvedValue({ rejected: [], response: '250 ok' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('crea el transporte con tiempos máximos de conexión, saludo y socket (10/10/20 s): un SMTP colgado no retiene la función', async () => {
    expect(await sendMail(params)).toEqual({ success: true, transport: 'smtp' });
    const opts = mailer.createTransport.mock.calls[0][0];
    expect(opts).toMatchObject({ host: 'smtp.cliente.test', port: 587, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
    expect(SMTP_TIMEOUTS).toMatchObject({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  });

  it('un fallo de BD al leer la configuración NO es «No hay SMTP configurado»: es config_unavailable (reintentable) y no se intenta enviar', async () => {
    // En modo plataforma sin cliente en el contexto, `prisma` lanza al usarse: un error de acceso a la BD.
    vi.stubEnv('PLATFORM_MODE', 'on');
    const r = await sendMail(params);
    expect(r).toMatchObject({ success: false, transport: 'none', errorCode: 'config_unavailable' });
    expect(r.error).not.toMatch(/No hay SMTP/);
    expect(r.error).toMatch(/config_unavailable/);
    expect(mailer.createTransport).not.toHaveBeenCalled();
    await expect(getConfigsOrFail(['smtp_host'])).rejects.toBeInstanceOf(ConfigReadError);
  });

  it('sin SMTP configurado (apagado o sin host) sí es «No hay SMTP configurado», con su propio código', async () => {
    await getAndSetConfig('smtp_enabled', 'false');
    const off = await sendMail(params);
    expect(off).toEqual({ success: false, transport: 'none', error: 'No hay SMTP configurado', errorCode: 'smtp_not_configured' });
    await getAndSetConfig('smtp_enabled', 'true');
    expect(mailer.createTransport).not.toHaveBeenCalled();
  });

  it('un error del servidor SMTP sale sin la contraseña, el usuario ni direcciones de correo, con su código y acotado', async () => {
    const err = Object.assign(new Error(`Invalid login for usuario@cliente.es with contraseña-secreta-123: 535 5.7.8 rechazado para comprador@example.com`), { code: 'EAUTH' });
    mailer.sendMail.mockRejectedValue(err);
    const r = await sendMail(params);
    expect(r).toMatchObject({ success: false, errorCode: 'smtp_unavailable' }); // credenciales rechazadas: fallo SISTÉMICO del servidor de correo
    expect(r.error).toMatch(/^EAUTH: /);
    for (const secret of ['contraseña-secreta-123', 'usuario@cliente.es', 'comprador@example.com', '@']) expect(r.error, secret).not.toContain(secret);
    expect(r.error!.length).toBeLessThanOrEqual(160);
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(logged).not.toContain('contraseña-secreta-123');
    expect(logged).not.toContain('comprador@example.com');
  });

  it('un destinatario rechazado se informa sin su dirección', async () => {
    mailer.sendMail.mockResolvedValue({ rejected: ['comprador@example.com'], response: '550 5.1.1 comprador@example.com no existe' });
    const r = await sendMail(params);
    expect(r).toMatchObject({ success: false, errorCode: 'smtp_rejected' });
    expect(r.error).not.toContain('comprador@example.com');
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(logged).not.toContain('comprador@example.com');
  });

  it('classifySmtpError: conexión, DNS, tiempo y credenciales son del servidor (sistémico); EENVELOPE es el destinatario (permanente); lo demás, genérico', () => {
    for (const code of ['ECONNECTION', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'ENOTFOUND', 'EDNS', 'EAUTH', 'ETLS']) expect(classifySmtpError({ code }), code).toBe('smtp_unavailable');
    expect(classifySmtpError({ code: 'EENVELOPE' })).toBe('smtp_rejected');
    expect(classifySmtpError({ code: 'EMESSAGE' })).toBe('smtp_failed');
    expect(classifySmtpError(new Error('boom'))).toBe('smtp_failed');
    expect(classifySmtpError(null)).toBe('smtp_failed');
  });

  it('un EENVELOPE lanzado por nodemailer sale como smtp_rejected, sin la dirección', async () => {
    mailer.sendMail.mockRejectedValue(Object.assign(new Error('No recipients defined: comprador@example.com'), { code: 'EENVELOPE' }));
    const r = await sendMail(params);
    expect(r).toMatchObject({ success: false, errorCode: 'smtp_rejected' });
    expect(r.error).not.toContain('comprador@example.com');
  });

  it('describeMailError: oculta secretos y correos, pone el código delante, una línea y como mucho 160 caracteres', () => {
    expect(describeMailError(Object.assign(new Error('boom secreto-x'), { code: 'ETIMEDOUT' }), ['secreto-x'])).toBe('ETIMEDOUT: boom ***');
    expect(describeMailError(new Error('a\n\nb   c'))).toBe('a b c');
    expect(describeMailError(new Error('x'.repeat(400)))).toHaveLength(160);
    expect(describeMailError(new Error(''))).toBe('Error desconocido al enviar');
    expect(describeMailError('texto suelto de juan@x.es')).toBe('texto suelto de [email]');
  });
});
