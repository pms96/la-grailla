// AUDIT: PERF-03 — buildApplePass no comprobaba la caducidad del certificado
// antes de firmar. passkit-generator no valida la fecha, así que un certificado
// caducado "firma" el pase sin ningún error: se descubre cuando el comprador
// intenta añadirlo a Apple Wallet y falla, el peor momento posible para
// enterarse. Se añade una alerta por email con 30 días de margen, reutilizando
// el patrón de alertPaidButInactiveOrder (lib/order-reconciliation.ts).
//
// alertAppleCertExpiringSoon se exporta para poder testear el dedup sin tener
// que generar un .p12 real cada vez.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/prisma';

type SentMail = { to: string; subject: string; html: string };
const sendMailMock = vi.fn(async (_params: SentMail) => ({ success: true, transport: 'smtp' as const }));
vi.mock('@/lib/mailer', () => ({ sendMail: (params: SentMail) => sendMailMock(params) }));

const { alertAppleCertExpiringSoon } = await import('@/lib/wallet');

const ALERT_CONFIG_KEY = 'apple_wallet_cert_expiry_alerted_for';

describe('AUDIT — alertAppleCertExpiringSoon (PERF-03)', () => {
  beforeEach(async () => {
    sendMailMock.mockClear();
    await prisma.appConfig.deleteMany({ where: { key: ALERT_CONFIG_KEY } });
  });

  afterEach(async () => {
    await prisma.appConfig.deleteMany({ where: { key: ALERT_CONFIG_KEY } });
  });

  it('envía la alerta y guarda el certificado ya alertado', async () => {
    const notAfter = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await alertAppleCertExpiringSoon(notAfter, 5);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const [params] = sendMailMock.mock.calls[0];
    expect(params.to).toBe('grupolagrailla@gmail.com');
    expect(params.subject).toMatch(/caduca en 5 día/);

    const stored = await prisma.appConfig.findUnique({ where: { key: ALERT_CONFIG_KEY } });
    expect(stored?.value).toBe(notAfter.toISOString());
  });

  it('no repite el email para el mismo certificado (mismo notAfter)', async () => {
    const notAfter = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await alertAppleCertExpiringSoon(notAfter, 5);
    await alertAppleCertExpiringSoon(notAfter, 4);
    await alertAppleCertExpiringSoon(notAfter, 3);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('vuelve a alertar si el certificado se renueva (notAfter distinto)', async () => {
    const firstNotAfter = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await alertAppleCertExpiringSoon(firstNotAfter, 5);

    const renewedNotAfter = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    await alertAppleCertExpiringSoon(renewedNotAfter, 400);

    // La segunda llamada no está dentro de la ventana de 30 días en un uso
    // real (buildApplePass no la invocaría), pero la función en sí no impone
    // esa ventana — solo el dedup por certificado, que es lo que se prueba aquí.
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it('distingue el mensaje de "ya caducado" del de "caduca pronto"', async () => {
    const pastNotAfter = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await alertAppleCertExpiringSoon(pastNotAfter, 0);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const [params] = sendMailMock.mock.calls[0];
    expect(params.subject).toMatch(/ha caducado/i);
  });
});
