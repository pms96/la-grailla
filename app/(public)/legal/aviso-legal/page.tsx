// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

import { getConfig } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';
import { LegalShell } from '../../_templates/legal-shell';

export const metadata = {
  title: 'Aviso legal',
};

export default async function AvisoLegalPage() {
  const [text, brand] = await Promise.all([getConfig('legal_notice'), getBrand()]);
  const mailto = brand.contactEmail;

  return (
    <LegalShell title="Aviso legal" brand={brand}>
        {text ? (
          <div className="whitespace-pre-line text-muted-foreground leading-relaxed">{text}</div>
        ) : (
          <div className="space-y-4 text-muted-foreground leading-relaxed">
            <p>
              Este sitio es operado por {brand.legalName}.
              {mailto && (
                <>
                  {' '}Para cualquier consulta sobre estas condiciones, escríbenos a{' '}
                  <span suppressHydrationWarning>{mailto}</span>.
                </>
              )}
            </p>
          </div>
        )}
    </LegalShell>
  );
}
