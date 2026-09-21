import { describe, it, expect } from 'vitest';
import {
  getOnlineSalesClosedLabel,
  getOnlineSalesClosedMessage,
  DEFAULT_ONLINE_SALES_CLOSED_LABEL,
  DEFAULT_ONLINE_SALES_CLOSED_MESSAGE,
} from '@/lib/online-sales-closed';

describe('getOnlineSalesClosedLabel', () => {
  it('devuelve null si el evento no tiene la venta online cerrada', () => {
    expect(getOnlineSalesClosedLabel({ onlineSalesClosed: false, onlineSalesClosedLabel: 'Custom' })).toBeNull();
  });

  it('usa la etiqueta por defecto si no hay una personalizada', () => {
    expect(getOnlineSalesClosedLabel({ onlineSalesClosed: true, onlineSalesClosedLabel: null })).toBe(DEFAULT_ONLINE_SALES_CLOSED_LABEL);
  });

  it('usa la etiqueta personalizada cuando está definida', () => {
    expect(getOnlineSalesClosedLabel({ onlineSalesClosed: true, onlineSalesClosedLabel: 'Agotado online' })).toBe('Agotado online');
  });

  // AUDIT: una etiqueta personalizada con solo espacios no debe colarse como
  // "definida" en vez de caer a la etiqueta por defecto.
  it('trata una etiqueta personalizada en blanco como si no existiera', () => {
    expect(getOnlineSalesClosedLabel({ onlineSalesClosed: true, onlineSalesClosedLabel: '   ' })).toBe(DEFAULT_ONLINE_SALES_CLOSED_LABEL);
  });
});

describe('getOnlineSalesClosedMessage', () => {
  it('devuelve null si el evento no tiene la venta online cerrada', () => {
    expect(getOnlineSalesClosedMessage({ onlineSalesClosed: false, onlineSalesClosedMessage: 'Custom' })).toBeNull();
  });

  it('usa el mensaje por defecto si no hay uno personalizado', () => {
    expect(getOnlineSalesClosedMessage({ onlineSalesClosed: true, onlineSalesClosedMessage: null })).toBe(DEFAULT_ONLINE_SALES_CLOSED_MESSAGE);
  });

  it('usa el mensaje personalizado cuando está definido', () => {
    const message = getOnlineSalesClosedMessage({
      onlineSalesClosed: true,
      onlineSalesClosedMessage: 'Recógelas en la entrada, junto al photocall.',
    });
    expect(message).toBe('Recógelas en la entrada, junto al photocall.');
  });

  it('trata un mensaje personalizado en blanco como si no existiera', () => {
    expect(getOnlineSalesClosedMessage({ onlineSalesClosed: true, onlineSalesClosedMessage: '   ' })).toBe(DEFAULT_ONLINE_SALES_CLOSED_MESSAGE);
  });
});
