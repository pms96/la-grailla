export const revalidate = 60;

import { getConfig } from '@/lib/config';
import { Container } from '@/components/layouts/container';

export const metadata = {
  title: 'Aviso legal | La Grailla',
};

export default async function AvisoLegalPage() {
  const text = await getConfig('legal_notice');

  return (
    <Container className="py-16">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">Aviso legal</h1>
        {text ? (
          <div className="whitespace-pre-line text-muted-foreground leading-relaxed">{text}</div>
        ) : (
          <div className="space-y-4 text-muted-foreground leading-relaxed">
            <p>
              Este sitio es operado por Grupo La Grailla. Para cualquier consulta sobre estas condiciones, escríbenos a{' '}
              <span suppressHydrationWarning>grupolagrailla@gmail.com</span>.
            </p>
          </div>
        )}
      </div>
    </Container>
  );
}
