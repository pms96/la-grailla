export const dynamic = 'force-dynamic';

import { Container } from '@/components/layouts/container';
import ShopConfirmationClient from './_components/shop-confirmation-client';

export default async function ShopConfirmationPage(
  props: {
    params: Promise<{ orderId: string }>;
    searchParams?: Promise<{ t?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  return (
    <Container size="md">
      <ShopConfirmationClient orderId={params.orderId} accessToken={searchParams?.t ?? ''} />
    </Container>
  );
}
