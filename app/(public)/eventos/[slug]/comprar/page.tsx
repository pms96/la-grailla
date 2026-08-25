import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import type { Prisma } from '@prisma/client';
import { Container } from '@/components/layouts/container';
import { Button } from '@/components/ui/button';
import { hasEventEnded } from '@/lib/active-event';
import { getConfig } from '@/lib/config';
import WaitingRoomGate from './_components/waiting-room-gate';

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

  if (hasEventEnded(event.date)) {
    return (
      <Container size="md">
        <div className="py-20 text-center space-y-4">
          <p className="font-display text-xl font-bold tracking-tight">Este evento ya ha finalizado</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Ya no se pueden comprar entradas para {event.name}. Echa un vistazo a la próxima fecha.
          </p>
          <Button asChild>
            <Link href="/eventos">Ver programación</Link>
          </Button>
        </div>
      </Container>
    );
  }

  // Se calcula aquí (servidor) y se manda como prop en vez de que el
  // formulario la pida por su cuenta: es la misma comisión que
  // app/api/orders/route.ts añadirá al cobrar, así el comprador ve el total
  // real ANTES de llegar a la pasarela, no una sorpresa al pagar.
  const commissionPercent = parseFloat(await getConfig('commission_percentage')) || 0;
  const serializedEvent = { ...JSON.parse(JSON.stringify(event)), commissionPercent };

  return (
    <Container size="md">
      <div className="py-8">
        <WaitingRoomGate event={serializedEvent} />
      </div>
    </Container>
  );
}
