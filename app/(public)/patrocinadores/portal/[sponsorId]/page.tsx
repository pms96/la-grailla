import { Container } from '@/components/layouts/container';
import SponsorPortalClient from './_components/sponsor-portal-client';

export const dynamic = 'force-dynamic';

export default function SponsorPortalPage({
  params,
  searchParams,
}: {
  params: { sponsorId: string };
  searchParams?: { t?: string };
}) {
  return (
    <Container size="md">
      <div className="py-8">
        <SponsorPortalClient sponsorId={params?.sponsorId ?? ''} accessToken={searchParams?.t ?? ''} />
      </div>
    </Container>
  );
}
