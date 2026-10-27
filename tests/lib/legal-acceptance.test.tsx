import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LegalAcceptance } from '@/components/legal-acceptance';
import { FiscalFootnote } from '@/components/fiscal-footnote';

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí (igual que map-facade.test).
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const noop = () => {};

describe('LegalAcceptance (P0-11)', () => {
  it('entradas: casilla con enlaces a las condiciones de entradas y a la privacidad, en pestaña nueva', () => {
    const html = render(<LegalAcceptance kind="entradas" accepted={false} onAcceptedChange={noop} />);
    expect(html).toContain('href="/legal/condiciones-entradas"');
    expect(html).toContain('href="/legal/privacidad"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('type="button"'); // el checkbox de Radix es un botón: no envía el formulario
    expect(html).not.toContain('age-confirmed');
  });

  it('tienda: enlaza a las condiciones de la tienda', () => {
    const html = render(<LegalAcceptance kind="tienda" accepted onAcceptedChange={noop} />);
    expect(html).toContain('href="/legal/condiciones-tienda"');
    expect(html).not.toContain('condiciones-entradas');
  });

  it('con aviso de edad añade la segunda casilla con el texto del evento; el error se anuncia', () => {
    const html = render(
      <LegalAcceptance kind="entradas" accepted={false} onAcceptedChange={noop} error="Falta aceptar" ageMessage="Debes tener 18 años" ageConfirmed={false} onAgeConfirmedChange={noop} ageError="Confirma la edad" />
    );
    expect(html).toContain('Debes tener 18 años');
    expect(html).toContain('id="age-confirmed"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Falta aceptar');
    expect(html).toContain('Confirma la edad');
  });

  it('«IVA incluido» solo si se pide', () => {
    expect(render(<LegalAcceptance kind="entradas" accepted={false} onAcceptedChange={noop} vatIncluded />)).toContain('Precios con IVA incluido.');
    expect(render(<LegalAcceptance kind="entradas" accepted={false} onAcceptedChange={noop} />)).not.toContain('IVA incluido');
  });
});

describe('FiscalFootnote (P0-11)', () => {
  it('con todo: IVA desglosado, vendedor y «no es una factura» con a dónde pedirla', () => {
    const html = render(
      <FiscalFootnote fiscal={{ issuer: { name: 'Acme SL', nif: 'B1', address: 'Calle 1' }, vat: { rate: 10, base: 10, vat: 1, total: 11 }, invoiceEmail: 'hola@acme.test' }} />
    );
    expect(html).toContain('IVA incluido (10 %)');
    expect(html).toContain('base 10,00 €');
    expect(html).toContain('cuota 1,00 €');
    expect(html).toContain('Acme SL');
    expect(html).toContain('NIF B1');
    expect(html).toContain('no es una factura');
    expect(html).toContain('hola@acme.test');
  });

  it('sin datos fiscales: solo la aclaración; sin objeto fiscal (pedido sin pagar): nada', () => {
    const bare = render(<FiscalFootnote fiscal={{ issuer: null, vat: null, invoiceEmail: null }} />);
    expect(bare).toContain('no es una factura');
    expect(bare).not.toContain('NIF');
    expect(render(<FiscalFootnote fiscal={null} />)).toBe('');
  });
});
