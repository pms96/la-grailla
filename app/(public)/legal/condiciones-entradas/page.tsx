// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { getBrand } from '@/lib/brand/brand';
import { getTermsText } from '@/lib/legal-terms';
import { isModuleEnabled } from '@/lib/modules/runtime';
import { LegalShell } from '../../_templates/legal-shell';
import { canonicalAlternates } from '@/lib/seo/canonical';

export function generateMetadata() {
  return { title: 'Condiciones de venta de entradas', ...canonicalAlternates('/legal/condiciones-entradas') };
}

/** Condiciones de venta de entradas (P0-11): las que escribió el cliente o, si no hay, el borrador por defecto. Solo existe con el módulo Entradas. */
export default async function CondicionesEntradasPage() {
  if (!isModuleEnabled('entradas')) notFound();
  const [{ text }, brand] = await Promise.all([getTermsText('entradas'), getBrand()]);
  return (
    <LegalShell title="Condiciones de venta de entradas" brand={brand}>
      <div className="whitespace-pre-line text-muted-foreground leading-relaxed">{text}</div>
    </LegalShell>
  );
}
