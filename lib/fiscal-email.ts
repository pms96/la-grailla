import { escapeHtml as esc } from '@/lib/html-escape';
import { vatText, type FiscalView } from '@/lib/fiscal';

/* P0-11 · Pie fiscal de los correos de compra (HTML en línea, estilos de correo): IVA desglosado si está configurado, vendedor y la aclaración
 * de que el correo es un justificante y NO una factura. Mismo contenido que components/fiscal-footnote.tsx, pero escapado a mano. */
export function fiscalEmailHtml(fiscal: FiscalView): string {
  const lines: string[] = [];
  if (fiscal.vat) lines.push(esc(vatText(fiscal.vat)));
  if (fiscal.issuer) {
    lines.push(esc(`${fiscal.issuer.name} · NIF ${fiscal.issuer.nif}${fiscal.issuer.address ? ' · ' + fiscal.issuer.address : ''}`));
  }
  lines.push(
    'Justificante de compra: no es una factura.' +
      (fiscal.invoiceEmail ? ' Si necesitas factura, escribe a ' + esc(fiscal.invoiceEmail) + ' con tu referencia y tus datos fiscales.' : '')
  );
  return '<p style="font-size:12px;color:#777;line-height:1.5;margin:14px 0 0;">' + lines.join('<br/>') + '</p>';
}
