import Link from 'next/link';
import { loadOrFail } from '@/lib/public-load';
import { toPublicEvent } from '@/lib/public-event';
import { prisma, type EventWithTicketTypes } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import { Container } from '@/components/layouts/container';
import { Button } from '@/components/ui/button';
import { hasEventEnded } from '@/lib/active-event';
import { getConfig } from '@/lib/config';
import { getCaptchaSiteKey } from '@/lib/captcha';
import { currentVatRate } from '@/lib/fiscal';
import { termsVersionOrNull } from '@/lib/legal-terms';
import { EVENT_CANCELLED_NOTICE, EVENT_CANCELLED_TITLE } from '@/lib/event-cancelled-copy';
import { getOnlineSalesClosedLabel, getOnlineSalesClosedMessage } from '@/lib/online-sales-closed';
import WaitingRoomGate from './_components/waiting-room-gate';

export const dynamic = 'force-dynamic';

// H-244: página transaccional (arranca la cola al renderizar): no se indexa. El `robots.txt` solo pide no rastrear; esto impide que una URL enlazada acabe en el índice.
export const metadata = { title: 'Comprar entradas', robots: { index: false, follow: false } };

export default async function ComprarPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  // H-228: un fallo de BD LANZA (la web pinta su error con reintento) en vez de acabar en `notFound()`: en el pico de un lanzamiento el comprador veía un 404 «este evento no existe».
  const event: EventWithTicketTypes | null = await loadOrFail('ComprarPage', () =>
    prisma.event.findUnique({
      where: { slug: params?.slug },
      include: {
        ticketTypes: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    })
  );

  // H-099: un evento CANCELADO existe: se dice que está cancelado y qué hacer, en lugar de un 404 genérico. Un borrador o un evento inexistente siguen dando 404.
  if (event?.status === 'CANCELLED') {
    return (
      <Container size="md">
        <div className="py-20 text-center space-y-4">
          <p className="font-display text-xl font-bold tracking-tight">{EVENT_CANCELLED_TITLE}</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">{EVENT_CANCELLED_NOTICE}</p>
          <Button asChild>
            <Link href="/eventos">Ver programación</Link>
          </Button>
        </div>
      </Container>
    );
  }

  if (!event || event?.status !== 'PUBLISHED') notFound();

  // Bloqueo server-side, no solo de UI — cualquiera con el enlace directo
  // (guardado antes de cerrarse, o compartido) debe ver esto en vez del
  // formulario de compra. app/api/orders/route.ts rechaza igual la creación
  // del pedido si alguien se salta esta pantalla llamando a la API a mano.
  if (event.onlineSalesClosed) {
    return (
      <Container size="md">
        <div className="py-20 text-center space-y-4">
          <p className="font-display text-xl font-bold tracking-tight">{getOnlineSalesClosedLabel(event)}</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">{getOnlineSalesClosedMessage(event)}</p>
          <Button asChild>
            <Link href="/eventos">Ver programación</Link>
          </Button>
        </div>
      </Container>
    );
  }

  if (hasEventEnded(event.date, event.endTime)) {
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
  const vatRate = await currentVatRate('entradas');
  // Versión de las condiciones con las que se pinta ESTA pantalla: el pedido la devuelve y el servidor comprueba que no han cambiado (409 si cambiaron).
  const termsVersion = await termsVersionOrNull('entradas', event.conditions ?? '');
  // Sin versión no hay formulario: el servidor no podría comprobar que el comprador vio las condiciones vigentes (H-143).
  if (!termsVersion) {
    return (
      <Container size="md">
        <div className="py-8">
          <p role="alert" className="text-muted-foreground">No podemos mostrar ahora las condiciones de venta, así que la compra no está disponible. Vuelve a intentarlo en unos minutos.</p>
        </div>
      </Container>
    );
  }
  const captchaSiteKey = await getCaptchaSiteKey();
  // H-244: sin los campos internos (umbrales y avisos de aforo, temporada): `toPublicEvent` es lo que ya hace la API pública del evento.
  const serializedEvent = { ...JSON.parse(JSON.stringify(toPublicEvent(event))), commissionPercent, vatRate, termsVersion, captchaSiteKey };

  return (
    <Container size="md">
      <div className="py-8">
        <WaitingRoomGate event={serializedEvent} />
      </div>
    </Container>
  );
}
