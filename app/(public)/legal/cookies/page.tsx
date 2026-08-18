export const dynamic = 'force-dynamic';

import { getConfig } from '@/lib/config';
import { Container } from '@/components/layouts/container';

export const metadata = {
  title: 'Política de cookies | La Grailla',
};

export default async function CookiesPolicyPage() {
  const text = await getConfig('cookies_policy');

  return (
    <Container className="py-16">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">Política de cookies</h1>
        {text ? (
          <div className="whitespace-pre-line text-muted-foreground leading-relaxed">{text}</div>
        ) : (
          <div className="space-y-4 text-muted-foreground leading-relaxed">
            <p>
              En La Grailla utilizamos cookies propias estrictamente necesarias para que la web funcione: mantener tu
              sesión iniciada, recordar el contenido de tu carrito y guardar tus preferencias de privacidad.
            </p>
            <p>
              Estas cookies no se pueden desactivar porque sin ellas la web no puede funcionar correctamente. No
              utilizamos cookies publicitarias ni compartimos datos con terceros con fines comerciales.
            </p>
            <p>
              Puedes borrar las cookies en cualquier momento desde la configuración de tu navegador. Si tienes cualquier
              duda sobre el tratamiento de tus datos, escríbenos a{' '}
              <span suppressHydrationWarning>grupolagrailla@gmail.com</span>.
            </p>
          </div>
        )}
      </div>
    </Container>
  );
}
