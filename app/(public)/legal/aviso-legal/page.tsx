// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

import { getConfigsOrFail } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';
import { LegalShell } from '../../_templates/legal-shell';
import { canonicalAlternates } from '@/lib/seo/canonical';

export function generateMetadata() {
  return { title: 'Aviso legal', ...canonicalAlternates('/legal/aviso-legal') };
}

export default async function AvisoLegalPage() {
  // H-104: si la BD falla, LANZA (500, que el CDN no guarda): con `getConfig` se pintaba el texto genérico con 200 y el CDN lo servía a todos 60-90 s.
  const [{ legal_notice: text }, brand] = await Promise.all([getConfigsOrFail(['legal_notice']), getBrand()]);
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
