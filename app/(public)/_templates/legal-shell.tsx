import { Container } from '@/components/layouts/container';
import type { Brand } from '@/lib/brand/brand';
import { PageBanner, hasBanner } from './page-banner';

/** Marco de las páginas legales. Todas las plantillas llevan su cabecera (versión compacta) salvo Feria, que conserva el mismo marcado de siempre. */
export function LegalShell({ title, brand, children }: { title: string; brand: Brand; children: React.ReactNode }) {
  if (hasBanner(brand.template)) {
    return (
      <>
        <PageBanner
          template={brand.template}
          brandName={brand.name}
          title={title}
          eyebrow="Legal"
          italicAccent={brand.theme?.fonts.display === 'instrument-serif'}
          compact
        />
        <Container size="xl" className="py-12 md:py-16">
          <div className="max-w-3xl space-y-6">{children}</div>
        </Container>
      </>
    );
  }
  return (
    <Container className="py-16">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">{title}</h1>
        {children}
      </div>
    </Container>
  );
}
