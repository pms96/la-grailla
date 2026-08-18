import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import type { Prisma } from '@prisma/client';
import { Container } from '@/components/layouts/container';
import BuyTicketsForm from './_components/buy-tickets-form';

export const dynamic = 'force-dynamic';

type EventWithTicketTypes = Prisma.EventGetPayload<{ include: { ticketTypes: true } }>;

export default async function ComprarPage({ params }: { params: { slug: string } }) {
  let event: EventWithTicketTypes | null = null;
  try {
    event = await prisma.event.findUnique({
      where: { slug: params?.slug },
      include: {
        ticketTypes: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
  } catch (error) {
    console.error('[ComprarPage] Error al cargar el evento:', error);
  }

  if (!event || event?.status !== 'PUBLISHED') notFound();

  const serializedEvent = JSON.parse(JSON.stringify(event));

  return (
    <Container size="md">
      <div className="py-8">
        <BuyTicketsForm event={serializedEvent} />
      </div>
    </Container>
  );
}
