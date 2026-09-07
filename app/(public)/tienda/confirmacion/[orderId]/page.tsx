export const dynamic = 'force-dynamic';

import { Container } from '@/components/layouts/container';
import ShopConfirmationClient from './_components/shop-confirmation-client';

export default function ShopConfirmationPage({
  params,
  searchParams,
}: {
  params: { orderId: string };
  searchParams?: { t?: string };
}) {
  return (
    <Container size="md">
      <ShopConfirmationClient orderId={params.orderId} accessToken={searchParams?.t ?? ''} />
    </Container>
  );
}
