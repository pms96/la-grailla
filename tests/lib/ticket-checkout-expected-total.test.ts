import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* H-215 (cliente): el formulario de entradas manda el total que está viendo y, si el servidor responde `price_changed`, vuelve a pedir los datos del evento en lugar de
 * dejar al comprador con un precio que ya no es. (El contraste en sí lo prueba tests/api/orders.test.ts.) */

const ROOT = path.resolve(__dirname, '../..');
const form = fs.readFileSync(path.join(ROOT, 'app/(public)/eventos/[slug]/comprar/_components/buy-tickets-form.tsx'), 'utf8');

describe('buy-tickets-form: el precio que se cobra es el que se vio', () => {
  it('manda `expectedTotalCents` calculado en céntimos con el total que enseña la pantalla', () => {
    expect(form).toMatch(/expectedTotalCents:\s*toCents\(grandTotal\)/);
  });

  it('ante `price_changed` refresca los datos del evento y avisa (no se queda con el precio viejo)', () => {
    expect(form).toMatch(/data\?\.code === 'price_changed'/);
    expect(form).toMatch(/router\.refresh\(\)/);
  });
});
