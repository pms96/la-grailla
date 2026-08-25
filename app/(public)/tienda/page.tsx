import { ShoppingBag } from 'lucide-react';
import { Container } from '@/components/layouts/container';
import { FadeIn } from '@/components/ui/animate';
import ShopGrid from './_components/shop-grid';

export const revalidate = 60;

export const metadata = {
  title: 'Tienda | La Grailla',
  description: 'Merch oficial de La Grailla. Lleva la caseta de feria contigo — bajo pedido.',
};

export default function TiendaPage() {
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
