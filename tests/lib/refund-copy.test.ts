import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUNDED_TITLE, refundedMessage } from '@/lib/refund-copy';

describe('texto del pedido reembolsado (H-098)', () => {
  it('dice el importe y qué pasa con el dinero, sin afirmar que el pedido «no se ha podido completar»', () => {
    const text = refundedMessage(20);
    expect(text).toContain('20.00€');
    expect(text).toMatch(/método de pago original/);
    expect(text).toMatch(/escríbenos con tu referencia/);
    expect(text).not.toMatch(/no se ha podido completar/i);
  });

  it('un importe ilegible no pinta NaN', () => {
    expect(refundedMessage(Number.NaN)).toContain('0.00€');
  });

  it('el título es el mismo en ambas pantallas', () => {
    expect(REFUNDED_TITLE).toBe('Te hemos devuelto el pago');
  });

  it('las dos confirmaciones (entradas y tienda) usan este texto y ya no tienen la frase falsa', () => {
    for (const rel of ['app/(public)/confirmacion/[orderId]/_components/confirmation-client.tsx', 'app/(public)/tienda/confirmacion/[orderId]/_components/shop-confirmation-client.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(src, rel).toContain('refundedMessage(');
      expect(src, rel).not.toMatch(/no se ha podido completar y te hemos devuelto/);
    }
  });
});
