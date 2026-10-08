import { Container } from '@/components/layouts/container';
import ShopCheckoutClient from './_components/shop-checkout-client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Finalizar compra | Tienda',
  description: 'Completa tus datos de envío para tu pedido.',
};

export default function TiendaCheckoutPage() {
  return (
    <Container size="lg">
      <div className="py-8">
        <ShopCheckoutClient />
      </div>
    </Container>
  );
}
