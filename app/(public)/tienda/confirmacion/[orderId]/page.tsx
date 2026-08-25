export const dynamic = 'force-dynamic';

import { Container } from '@/components/layouts/container';
import ShopConfirmationClient from './_components/shop-confirmation-client';

export default function ShopConfirmationPage({ params }: { params: { orderId: string } }) {
  return (
    <Container size="md">
      <ShopConfirmationClient orderId={params.orderId} />
    </Container>
  );
}
