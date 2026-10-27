import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { confirmationView, emailNotice, shouldKeepPolling } from '@/lib/confirmation-state';
import { buyerEmailView } from '@/lib/order-email';

/* La decisión de qué dice la pantalla de confirmación (entradas y tienda) es una función pura: «no se ha realizado ningún cargo» solo si la pasarela lo
 * confirma, «estamos comprobando» solo mientras se está comprobando, y un mensaje final claro cuando se agota el sondeo. */
const v = (status: string, over: Partial<Parameters<typeof confirmationView>[0]> = {}) => confirmationView({ status, pollsExhausted: false, ...over });

describe('confirmationView', () => {
  it.each(['COMPLETED', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'])('%s → confirmed', (status) => {
    expect(v(status)).toBe('confirmed');
  });

  it('PENDING → pending; REFUNDED → refunded', () => {
    expect(v('PENDING')).toBe('pending');
    expect(v('REFUNDED')).toBe('refunded');
  });

  describe('CANCELLED', () => {
    it('sin pago asociado: nunca hubo cargo que comprobar → not_charged', () => {
      expect(v('CANCELLED', { paymentId: null })).toBe('not_charged');
      expect(v('CANCELLED', { paymentId: undefined, paymentCheck: 'none' })).toBe('not_charged');
    });

    it('con pago asociado y la pasarela confirmando que NO se pagó → not_charged («no se ha realizado ningún cargo»)', () => {
      expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck: 'not_paid' })).toBe('not_charged');
    });

    it('con pago asociado SIN confirmación (checking, none o ausente) → «comprobando», nunca «no se ha cobrado»', () => {
      for (const paymentCheck of ['checking', 'none', undefined, null] as const) {
        expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck }), String(paymentCheck)).toBe('checking');
      }
    });

    it('agotado el sondeo sin resolverse → mensaje final claro (checking_gave_up), que no afirma que no se cobró', () => {
      expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck: 'checking', pollsExhausted: true })).toBe('checking_gave_up');
    });

    it('si la pasarela confirma el no-pago, agotar el sondeo no lo cambia', () => {
      expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck: 'not_paid', pollsExhausted: true })).toBe('not_charged');
    });

    it('cobro devuelto → refunded', () => {
      expect(v('CANCELLED', { paymentId: 'cs_1', paymentCheck: 'refunded' })).toBe('refunded');
    });
  });

  it('solo se sigue sondeando mientras el resultado pueda cambiar', () => {
    expect(shouldKeepPolling('pending')).toBe(true);
    expect(shouldKeepPolling('checking')).toBe(true);
    for (const view of ['confirmed', 'checking_gave_up', 'not_charged', 'refunded'] as const) expect(shouldKeepPolling(view), view).toBe(false);
  });
});

/* P0-08: la pantalla ya no afirma «te hemos enviado un email» sin comprobarlo: cuenta el estado REAL del envío (`emailDelivery`). */
describe('emailNotice (estado real del email en las pantallas de confirmación)', () => {
  const notice = (kind: 'entradas' | 'tienda', delivery?: Parameters<typeof emailNotice>[0]['delivery']) => emailNotice({ kind, delivery, email: 'ana@ejemplo.es' });

  it.each(['entradas', 'tienda'] as const)('%s: enviado → «enviado» a su dirección; enviándose → «estamos enviándotelo»; nada se afirma de más', (kind) => {
    const sent = notice(kind, 'sent');
    expect(sent).toMatchObject({ tone: 'ok', keepPolling: false, offerDownload: false });
    expect(sent.detail).toContain('ana@ejemplo.es');
    const sending = notice(kind, 'sending');
    expect(sending).toMatchObject({ tone: 'pending', keepPolling: true });
    expect(sending.title).toMatch(/Enviando/);
    expect(sending.title).not.toMatch(/enviad[oa]s? por email$/); // no dice «enviadas»
  });

  it('entradas: reintentando → «te las enviaremos en unos minutos» con la descarga a mano; fallido → «no hemos podido enviarte el email» y descarga', () => {
    const retrying = notice('entradas', 'retrying');
    expect(retrying.title).toBe('Te las enviaremos en unos minutos');
    expect(retrying).toMatchObject({ tone: 'pending', keepPolling: true, offerDownload: true });
    const failed = notice('entradas', 'failed');
    expect(failed.title).toBe('No hemos podido enviarte el email');
    expect(failed).toMatchObject({ tone: 'problem', keepPolling: false, offerDownload: true });
    expect(failed.detail).toMatch(/Descarga tus entradas/);
  });

  it('tienda: reintentando → «te lo enviaremos en unos minutos»; fallido → no hemos podido; el justificante es la propia página', () => {
    expect(notice('tienda', 'retrying').title).toBe('Te lo enviaremos en unos minutos');
    const failed = notice('tienda', 'failed');
    expect(failed).toMatchObject({ tone: 'problem', keepPolling: false });
    expect(failed.detail).toMatch(/justificante/);
  });

  it('sin información (pedido anterior al seguimiento, o la API aún no lo trae): neutral, no afirma nada del email', () => {
    for (const delivery of ['unknown', null, undefined] as const) {
      for (const kind of ['entradas', 'tienda'] as const) {
        const nt = notice(kind, delivery);
        expect(nt.tone).toBe('neutral');
        expect(nt.keepPolling).toBe(false);
        expect(`${nt.title} ${nt.detail}`).not.toMatch(/hemos enviado|enviadas por email|enviado la confirmación/i);
      }
    }
  });

  it('buyerEmailView traduce el estado interno sin exponer nada técnico: agotado = failed; pendiente o en curso = sending', () => {
    expect(buyerEmailView({ status: 'sent' })).toBe('sent');
    expect(buyerEmailView({ status: 'exhausted' })).toBe('failed');
    expect(buyerEmailView({ status: 'retrying' })).toBe('retrying');
    expect(buyerEmailView({ status: 'pending' })).toBe('sending');
    expect(buyerEmailView({ status: 'sending' })).toBe('sending');
    expect(buyerEmailView({ status: 'unknown' })).toBe('unknown');
    expect(buyerEmailView(null)).toBe('unknown');
  });

  describe('las pantallas usan ese estado (no el texto fijo de antes) y no lanzan el envío por su cuenta', () => {
    const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

    it('entradas: sin la afirmación fija, sin el envío automático al abrir y con «Reenviar a mi email» por el reenvío con límite', () => {
      const s = src('app/(public)/confirmacion/[orderId]/_components/confirmation-client.tsx');
      expect(s).not.toMatch(/Entradas enviadas por email['"`]/);
      expect(s).not.toMatch(/Enviamos tus entradas a/);
      expect(s).not.toMatch(/listas — QR por email/);
      expect(s).toMatch(/emailNotice\(/);
      expect(s).toMatch(/Reenviar a mi email/);
      expect(s).toMatch(/softResend: true/);
      // El único fetch a send-tickets es el del botón (con softResend); no hay uno automático al cargar.
      expect(s.match(/send-tickets/g)).toHaveLength(1);
      expect(s).toMatch(/res\.status === 429/);
      expect(s).toMatch(/pdf-html/); // descarga a mano cuando el email no llega
    });

    it('tienda: sin «Te hemos enviado un email de confirmación» fijo, con el estado real y el botón de reenvío', () => {
      const s = src('app/(public)/tienda/confirmacion/[orderId]/_components/shop-confirmation-client.tsx');
      expect(s).not.toMatch(/Te hemos enviado un email de confirmación/);
      expect(s).toMatch(/emailNotice\(/);
      expect(s).toMatch(/Reenviar a mi email/);
      expect(s).toMatch(/send-email/);
      expect(s).toMatch(/res\.status === 429/);
    });
  });
});
