export const dynamic = 'force-dynamic';

import { getConfig } from '@/lib/config';
import { Container } from '@/components/layouts/container';

export const metadata = {
  title: 'Política de privacidad | La Grailla',
};

export default async function PrivacidadPage() {
  const text = await getConfig('privacy_policy');

  return (
    <Container className="py-16">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">Política de privacidad</h1>
        {text ? (
          <div className="whitespace-pre-line text-muted-foreground leading-relaxed">{text}</div>
        ) : (
          <div className="space-y-4 text-muted-foreground leading-relaxed">
            <p>
              En La Grailla tratamos tus datos personales (nombre, email, datos de compra) únicamente para gestionar tus
              entradas, pedidos y comunicaciones relacionadas con el evento. No vendemos ni compartimos tus datos con
              terceros con fines comerciales.
            </p>
            <p>
              Si tienes cualquier duda sobre el tratamiento de tus datos, escríbenos a{' '}
              <span suppressHydrationWarning>grupolagrailla@gmail.com</span>.
            </p>
          </div>
        )}
      </div>
    </Container>
  );
}
