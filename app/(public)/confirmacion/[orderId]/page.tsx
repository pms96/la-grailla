import { Container } from '@/components/layouts/container';
import ConfirmationClient from './_components/confirmation-client';

export const dynamic = 'force-dynamic';

export default async function ConfirmacionPage(
  props: {
    params: Promise<{ orderId: string }>;
    searchParams?: Promise<{ t?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  return (
    <Container size="md">
      <div className="py-8">
        <ConfirmationClient
          orderId={params?.orderId ?? ''}
          accessToken={searchParams?.t ?? ''}
        />
      </div>
    </Container>
  );
}
