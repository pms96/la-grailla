import { Container } from '@/components/layouts/container';
import SponsorPortalClient from './_components/sponsor-portal-client';

export const dynamic = 'force-dynamic';

export default async function SponsorPortalPage(
  props: {
    params: Promise<{ sponsorId: string }>;
    searchParams?: Promise<{ t?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  return (
    <Container size="md">
      <div className="py-8">
        <SponsorPortalClient sponsorId={params?.sponsorId ?? ''} accessToken={searchParams?.t ?? ''} />
      </div>
    </Container>
  );
}
