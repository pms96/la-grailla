// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

import { getConfig } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';
import { LegalShell } from '../../_templates/legal-shell';

export const metadata = {
  title: 'Política de cookies',
};

export default async function CookiesPolicyPage() {
  const [text, brand] = await Promise.all([getConfig('cookies_policy'), getBrand()]);
  const mailto = brand.contactEmail;

  return (
    <LegalShell title="Política de cookies" brand={brand}>
        {text ? (
          <div className="whitespace-pre-line text-muted-foreground leading-relaxed">{text}</div>
        ) : (
          <div className="space-y-4 text-muted-foreground leading-relaxed">
            <p>
              En {brand.name} utilizamos cookies propias estrictamente necesarias para que la web funcione: mantener tu
              sesión iniciada, recordar el contenido de tu carrito y guardar tus preferencias de privacidad.
            </p>
            <p>
              Estas cookies no se pueden desactivar porque sin ellas la web no puede funcionar correctamente. No
              utilizamos cookies publicitarias ni compartimos datos con terceros con fines comerciales.
            </p>
            <p>
              Puedes borrar las cookies en cualquier momento desde la configuración de tu navegador. Si tienes cualquier
              duda sobre el tratamiento de tus datos{mailto ? <>, escríbenos a{' '}
              <span suppressHydrationWarning>{mailto}</span></> : ''}.
            </p>
          </div>
        )}
    </LegalShell>
  );
}
