// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

import { getConfig } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';
import { Container } from '@/components/layouts/container';

export const metadata = {
  title: 'Política de privacidad',
};

export default async function PrivacidadPage() {
  const [text, brand] = await Promise.all([getConfig('privacy_policy'), getBrand()]);
  const mailto = brand.contactEmail;

  return (
    <Container className="py-16">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">Política de privacidad</h1>
        {text ? (
          <div className="whitespace-pre-line text-muted-foreground leading-relaxed">{text}</div>
        ) : (
          <div className="space-y-4 text-muted-foreground leading-relaxed">
            <p>
              En {brand.name} tratamos tus datos personales (nombre, email, datos de compra) únicamente para gestionar tus
              entradas, pedidos y comunicaciones relacionadas con el evento. No vendemos ni compartimos tus datos con
              terceros con fines comerciales.
            </p>
            {mailto && (
              <p>
                Si tienes cualquier duda sobre el tratamiento de tus datos, escríbenos a{' '}
                <span suppressHydrationWarning>{mailto}</span>.
              </p>
            )}
          </div>
        )}
      </div>
    </Container>
  );
}
