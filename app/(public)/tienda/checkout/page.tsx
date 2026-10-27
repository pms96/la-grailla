import { Container } from '@/components/layouts/container';
import { currentVatRate } from '@/lib/fiscal';
import ShopCheckoutClient from './_components/shop-checkout-client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Finalizar compra | Tienda',
  description: 'Completa tus datos de envío para tu pedido.',
};

export default async function TiendaCheckoutPage() {
  const vatRate = await currentVatRate('tienda');
  return (
    <Container size="lg">
      <div className="py-8">
        <ShopCheckoutClient vatIncluded={(vatRate ?? 0) > 0} />
      </div>
    </Container>
  );
}
