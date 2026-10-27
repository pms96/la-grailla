// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

import { getConfig } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';
import { LegalShell } from '../../_templates/legal-shell';
import { canonicalAlternates } from '@/lib/seo/canonical';
import { defaultPrivacyText } from '@/lib/legal-defaults';

export function generateMetadata() {
  return { title: 'Política de privacidad', ...canonicalAlternates('/legal/privacidad') };
}

export default async function PrivacidadPage() {
  const [text, brand] = await Promise.all([getConfig('privacy_policy'), getBrand()]);
  const mailto = brand.contactEmail;

  return (
    <LegalShell title="Política de privacidad" brand={brand}>
        <div className="whitespace-pre-line text-muted-foreground leading-relaxed">
          {text || defaultPrivacyText({ name: brand.name, email: mailto || undefined })}
        </div>
    </LegalShell>
  );
}
