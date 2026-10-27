import type { FiscalView } from '@/lib/fiscal';

/* P0-11 · Pie fiscal de los justificantes en pantalla: vendedor (razón social, NIF, domicilio), IVA desglosado si el cliente lo configuró y la
 * aclaración de que NO es una factura, con a dónde pedirla. Sin datos fiscales configurados solo queda la aclaración. Sin estado ni cliente
 * propio: sirve tanto para una tarjeta normal como para el «papel» del recibo (clases de color por `tone`). */

const eur = (n: number) => n.toFixed(2).replace('.', ',') + ' €';

export function FiscalFootnote({ fiscal, tone = 'default', className = '' }: { fiscal?: FiscalView | null; tone?: 'default' | 'paper'; className?: string }) {
  if (!fiscal) return null;
  const { issuer, vat, invoiceEmail } = fiscal;
  const muted = tone === 'paper' ? 'text-black/55' : 'text-muted-foreground';
  const strong = tone === 'paper' ? 'text-black/80' : 'text-foreground/80';
  return (
    <div className={`space-y-1 text-xs leading-relaxed ${muted} ${className}`} data-testid="fiscal-footnote">
      {vat && (
        <p className="tabular-nums">
          <span className={strong}>IVA incluido ({String(vat.rate).replace('.', ',')} %)</span> · base {eur(vat.base)} · cuota {eur(vat.vat)}
        </p>
      )}
      {issuer && (
        <p>
          <span className={strong}>{issuer.name}</span> · NIF {issuer.nif}
          {issuer.address ? ` · ${issuer.address}` : ''}
        </p>
      )}
      <p>
        Justificante de compra: no es una factura.
        {invoiceEmail ? ` Si necesitas factura, escribe a ${invoiceEmail} con tu referencia y tus datos fiscales.` : ''}
      </p>
    </div>
  );
}
