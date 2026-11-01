// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

import { getBrand } from '@/lib/brand/brand';
import { getPrivacyText } from '@/lib/legal-terms';
import { LegalShell } from '../../_templates/legal-shell';
import { canonicalAlternates } from '@/lib/seo/canonical';

export function generateMetadata() {
  return { title: 'Política de privacidad', ...canonicalAlternates('/legal/privacidad') };
}

export default async function PrivacidadPage() {
  // El mismo texto que entra en el hash de lo que acepta el comprador (con la política en blanco o solo espacios, la de reserva): lo mostrado y lo registrado no divergen (H-143).
  const [text, brand] = await Promise.all([getPrivacyText(), getBrand()]);

  return (
    <LegalShell title="Política de privacidad" brand={brand}>
        <div className="whitespace-pre-line text-muted-foreground leading-relaxed">
          {text}
        </div>
    </LegalShell>
  );
}
