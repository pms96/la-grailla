import { Container } from '@/components/layouts/container';
import { FadeIn } from '@/components/ui/animate';
import ShopGrid from './_components/shop-grid';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Tienda | La Grailla',
  description: 'Merch oficial de La Grailla. Lleva la caseta de feria contigo — bajo pedido.',
};

export default function TiendaPage() {
  return (
    <Container size="lg">
      <div className="py-8">
        <FadeIn>
          <div className="relative mb-10">
            <div className="absolute -top-10 -left-10 w-64 h-64 rounded-full bg-lima/8 blur-3xl pointer-events-none" />
            <div className="inline-flex brand-sticker text-xs text-lima border-lima/60 shadow-lima/30 mb-4">
              🛒 MERCH OFICIAL
            </div>
            <h1 className="font-display text-3xl md:text-5xl font-bold tracking-tight mb-3">
              Tienda
            </h1>
            <p className="text-muted-foreground text-lg max-w-xl">
              Lleva La Grailla contigo. Merch oficial bajo pedido. ¡Que no se diga! 💜
            </p>
          </div>
        </FadeIn>
        <ShopGrid />
      </div>
    </Container>
  );
}
