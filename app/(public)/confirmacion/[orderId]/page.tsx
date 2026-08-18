import { Container } from '@/components/layouts/container';
import ConfirmationClient from './_components/confirmation-client';

export const dynamic = 'force-dynamic';

export default function ConfirmacionPage({ params }: { params: { orderId: string } }) {
  return (
    <Container size="md">
      <div className="py-8">
        <ConfirmationClient orderId={params?.orderId ?? ''} />
      </div>
    </Container>
  );
}
