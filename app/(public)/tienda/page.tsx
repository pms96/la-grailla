import { ShoppingBag } from 'lucide-react';
import { Container } from '@/components/layouts/container';
import { FadeIn } from '@/components/ui/animate';
import ShopGrid from './_components/shop-grid';
import { getBrand } from '@/lib/brand/brand';
import { getConfigs } from '@/lib/config';
import { PageBanner, hasBanner } from '../_templates/page-banner';

// Dinámica (no ISR): la caché por ruta mezclaría clientes; la de 60 s la hace el CDN por dominio (ver next.config.js).
export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const { name } = await getBrand();
  return { title: 'Tienda', description: `Tienda oficial de ${name}.` };
}

export default async function TiendaPage() {
  const brand = await getBrand();
  // Plantillas nuevas (marquesina, galería, tipo): cabecera propia con los textos que el cliente ha escrito en Configuración → Contenido.
  if (hasBanner(brand.template)) {
    const copy = await getConfigs(['home_shop_title', 'home_shop_subtitle']);
    return (
      <>
        <PageBanner
          template={brand.template}
          brandName={brand.name}
          title={copy.home_shop_title || 'Tienda'}
          lead={copy.home_shop_subtitle || 'Elige talla y color antes de pagar.'}
          italicAccent={brand.theme?.fonts.display === 'instrument-serif'}
        />
        <Container size="xl">
          <div className="py-10">
            <ShopGrid />
          </div>
        </Container>
      </>
    );
  }

  return (
    <Container size="lg">
      <div className="py-8">
        <FadeIn>
          {/* Cabecera compacta de catálogo — no hero de fiesta */}
          <div className="mb-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-b border-border/50 pb-8">
            <div>
              <div className="inline-flex items-center gap-1.5 text-xs font-display font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                <ShoppingBag className="h-3.5 w-3.5" /> Merch
              </div>
              <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight mb-2">Tienda</h1>
              <p className="text-muted-foreground max-w-md">
                Productos oficiales bajo pedido. Elige talla y color antes de pagar.
              </p>
            </div>
          </div>
        </FadeIn>
        <ShopGrid />
      </div>
    </Container>
  );
}
