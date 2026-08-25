'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Ticket,
  Minus,
  Plus,
  CreditCard,
  Loader2,
  ArrowLeft,
  Calendar,
  MapPin,
  ShieldCheck,
  Lock,
} from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn, PressScale } from '@/components/ui/animate';
import { cn } from '@/lib/utils';

interface TicketType {
  id: string;
  name: string;
  description: string | null;
  price: number;
  phaseName: string | null;
  maxQuantity: number;
  soldCount: number;
}

export interface EventData {
  id: string;
  name: string;
  slug: string;
  date?: string | Date;
  venue?: string | null;
  city?: string | null;
  minAge?: number | null;
  conditions?: string | null;
  ticketTypes: TicketType[];
}

type FieldErrors = {
  tickets?: string;
  buyerName?: string;
  buyerLastName?: string;
  buyerEmail?: string;
};

function formatEventDate(date: string | Date | undefined): string {
  if (!date) return '';
  try {
    return new Date(date).toLocaleDateString('es-ES', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return '';
  }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default function BuyTicketsForm({ event, queueToken }: { event: EventData; queueToken?: string }) {
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [buyerName, setBuyerName] = useState('');
  const [buyerLastName, setBuyerLastName] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [loading, setLoading] = useState(false);
  // Se genera una vez por intento y se manda en cada llamada a /api/orders,
  // incluida cualquier repetición de ESE MISMO intento (reintento de red,
  // doble clic antes de que se desactive el botón) — así el servidor puede
  // reconocer que es la misma compra y no crear un segundo pedido/cobro. Solo
  // se limpia tras una respuesta que confirma que el intento anterior no dejó
  // nada colgado (rechazo de negocio o fallo de pasarela ya cancelado en el
  // servidor); ante un fallo de red se mantiene, porque no sabemos si la
  // petición llegó a procesarse.
  const idempotencyKeyRef = useRef<string | null>(null);
  const ticketsSectionRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const lastNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const ticketTypes = event?.ticketTypes ?? [];
  const dateStr = formatEventDate(event?.date);
  const placeStr = [event?.venue, event?.city].filter(Boolean).join(', ');
  const minAge = event?.minAge ?? 18;

  const updateQty = (id: string, delta: number) => {
    setQuantities((prev) => {
      const current = prev?.[id] ?? 0;
      const tt = ticketTypes?.find((t: TicketType) => t?.id === id);
      const available = (tt?.maxQuantity ?? 0) - (tt?.soldCount ?? 0);
      const next = Math.max(0, Math.min(current + delta, Math.min(available, 10)));
      return { ...(prev ?? {}), [id]: next };
    });
    setErrors((prev) => ({ ...prev, tickets: undefined }));
  };

  const totalItems = Object.values(quantities ?? {}).reduce((s: number, q: number) => s + (q ?? 0), 0);
  const totalPrice = ticketTypes.reduce((s: number, tt: TicketType) => {
    return s + (tt?.price ?? 0) * (quantities?.[tt?.id] ?? 0);
  }, 0);

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (totalItems === 0) next.tickets = 'Elige al menos una entrada';
    if (!buyerName?.trim()) next.buyerName = 'Escribe tu nombre';
    if (!buyerLastName?.trim()) next.buyerLastName = 'Escribe tus apellidos';
    if (!buyerEmail?.trim()) next.buyerEmail = 'Escribe tu email';
    else if (!isValidEmail(buyerEmail.trim())) next.buyerEmail = 'El email no parece válido';
    return next;
  };

  const handleSubmit = async () => {
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      if (nextErrors.tickets) ticketsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else if (nextErrors.buyerName) nameRef.current?.focus();
      else if (nextErrors.buyerLastName) lastNameRef.current?.focus();
      else if (nextErrors.buyerEmail) emailRef.current?.focus();
      return;
    }

    setLoading(true);
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    try {
      const items = Object.entries(quantities ?? {})
        .filter(([, qty]: [string, number]) => (qty ?? 0) > 0)
        .map(([ticketTypeId, quantity]: [string, number]) => ({ ticketTypeId, quantity }));

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: event?.id,
          buyerName: buyerName?.trim(),
          buyerLastName: buyerLastName?.trim(),
          buyerEmail: buyerEmail?.trim(),
          items,
          queueToken,
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.success) {
        // Respuesta definitiva del servidor: si había un pedido a medias, ya
        // lo ha cancelado y liberado la clave por su cuenta — un reintento
        // necesita una clave nueva, no la misma.
        idempotencyKeyRef.current = null;
        toast.error(data?.error ?? 'No hemos podido preparar el pago. Inténtalo de nuevo.');
        return;
      }
      if (data?.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      const tokenQs = data?.accessToken ? `?t=${encodeURIComponent(data.accessToken)}` : '';
      router.push(`/confirmacion/${data.orderId}${tokenQs}`);
    } catch {
      // Fallo de red: no sabemos si el servidor llegó a procesar la
      // petición, así que se conserva la clave para que un reintento se
      // reconozca como el mismo intento en vez de crear un pedido duplicado.
      toast.error('Sin conexión. Revisa la red e inténtalo otra vez — no se cobrará dos veces.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <FadeIn>
      <div className="space-y-6 pb-28 md:pb-8">
        <div>
          <Link
            href={`/eventos/${event?.slug ?? ''}`}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <ArrowLeft className="h-4 w-4" /> Volver al evento
          </Link>
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Comprar entradas</h1>
          <p className="text-muted-foreground mt-1 font-display font-medium text-lg">{event?.name ?? ''}</p>
          <div className="flex flex-wrap gap-2 mt-3">
            {dateStr && (
              <Badge variant="secondary" className="gap-1 font-normal">
                <Calendar className="h-3 w-3" /> {dateStr}
              </Badge>
            )}
            {placeStr && (
              <Badge variant="secondary" className="gap-1 font-normal">
                <MapPin className="h-3 w-3" /> {placeStr}
              </Badge>
            )}
            <Badge variant="secondary" className="gap-1 font-normal">
              <ShieldCheck className="h-3 w-3" /> +{minAge}
            </Badge>
          </div>
          {event?.conditions && (
            <p className="text-xs text-muted-foreground mt-3">
              Al pagar aceptas las{' '}
              <a href={`/eventos/${event.slug}#condiciones`} className="text-primary underline-offset-2 hover:underline">
                condiciones de acceso
              </a>
              . Las entradas llegan por email con QR.
            </p>
          )}
        </div>

        <Card ref={ticketsSectionRef}>
          <CardContent className="p-6">
            <h2 className="font-display font-bold text-lg mb-4 flex items-center gap-2">
              <Ticket className="h-5 w-5 text-primary" /> Selecciona tus entradas
            </h2>
            <div className="space-y-4" role="group" aria-labelledby="tickets-heading">
              <span id="tickets-heading" className="sr-only">
                Tipos de entrada
              </span>
              {ticketTypes.map((tt: TicketType) => {
                const available = (tt?.maxQuantity ?? 0) - (tt?.soldCount ?? 0);
                const qty = quantities?.[tt?.id] ?? 0;
                const soldOut = available <= 0;
                return (
                  <div
                    key={tt?.id}
                    className={cn(
                      'flex items-center justify-between gap-3 p-4 rounded-lg border transition-colors',
                      qty > 0 ? 'bg-primary/5 border-primary/40' : 'bg-muted/50 border-transparent',
                      errors.tickets && qty === 0 && 'border-destructive/50'
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium">{tt?.name ?? ''}</p>
                        {tt?.phaseName && (
                          <Badge variant="outline" className="text-xs">
                            {tt.phaseName}
                          </Badge>
                        )}
                      </div>
                      {tt?.description && (
                        <p className="text-xs text-muted-foreground mt-1">{tt.description}</p>
                      )}
                      <p className="font-bold text-primary mt-1">{(tt?.price ?? 0).toFixed(2)}€</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {soldOut ? (
                        <Badge variant="destructive">Agotado</Badge>
                      ) : (
                        <>
                          <PressScale>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              aria-label={`Quitar ${tt?.name ?? 'entrada'}`}
                              onClick={() => updateQty(tt?.id, -1)}
                              disabled={qty <= 0}
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                          </PressScale>
                          <span className="w-8 text-center font-mono font-bold tabular-nums" aria-live="polite">
                            {qty}
                          </span>
                          <PressScale>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              aria-label={`Añadir ${tt?.name ?? 'entrada'}`}
                              onClick={() => updateQty(tt?.id, 1)}
                              disabled={qty >= available}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </PressScale>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {errors.tickets && (
              <p className="text-sm text-destructive mt-3" role="alert">
                {errors.tickets}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h2 className="font-display font-bold text-lg">Datos del comprador</h2>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="name">Nombre</Label>
                <Input
                  ref={nameRef}
                  id="name"
                  value={buyerName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setBuyerName(e?.target?.value ?? '');
                    setErrors((prev) => ({ ...prev, buyerName: undefined }));
                  }}
                  placeholder="Tu nombre"
                  className="mt-1"
                  variant={errors.buyerName ? 'error' : 'default'}
                  aria-invalid={!!errors.buyerName}
                  aria-describedby={errors.buyerName ? 'name-error' : undefined}
                  autoComplete="given-name"
                />
                {errors.buyerName && (
                  <p id="name-error" className="text-sm text-destructive mt-1" role="alert">
                    {errors.buyerName}
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="lastName">Apellidos</Label>
                <Input
                  ref={lastNameRef}
                  id="lastName"
                  value={buyerLastName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setBuyerLastName(e?.target?.value ?? '');
                    setErrors((prev) => ({ ...prev, buyerLastName: undefined }));
                  }}
                  placeholder="Tus apellidos"
                  className="mt-1"
                  variant={errors.buyerLastName ? 'error' : 'default'}
                  aria-invalid={!!errors.buyerLastName}
                  aria-describedby={errors.buyerLastName ? 'lastName-error' : undefined}
                  autoComplete="family-name"
                />
                {errors.buyerLastName && (
                  <p id="lastName-error" className="text-sm text-destructive mt-1" role="alert">
                    {errors.buyerLastName}
                  </p>
                )}
              </div>
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                ref={emailRef}
                id="email"
                type="email"
                value={buyerEmail}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setBuyerEmail(e?.target?.value ?? '');
                  setErrors((prev) => ({ ...prev, buyerEmail: undefined }));
                }}
                placeholder="tu@email.com"
                className="mt-1"
                variant={errors.buyerEmail ? 'error' : 'default'}
                aria-invalid={!!errors.buyerEmail}
                aria-describedby={errors.buyerEmail ? 'email-error' : 'email-hint'}
                autoComplete="email"
                inputMode="email"
              />
              {errors.buyerEmail ? (
                <p id="email-error" className="text-sm text-destructive mt-1" role="alert">
                  {errors.buyerEmail}
                </p>
              ) : (
                <p id="email-hint" className="text-xs text-muted-foreground mt-1">
                  Aquí recibirás el QR. Comprueba que esté bien escrito.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Resumen desktop — en móvil lo sustituye la barra fija */}
        <Card className="hidden md:block">
          <CardContent className="p-6">
            <div className="flex justify-between items-center gap-4 mb-4">
              <div>
                <p className="text-sm text-muted-foreground">
                  {totalItems} entrada{totalItems !== 1 ? 's' : ''}
                </p>
                <p className="font-display text-2xl font-bold tabular-nums">{totalPrice.toFixed(2)}€</p>
              </div>
              <PressScale>
                <Button
                  size="lg"
                  className="gap-2 font-display font-semibold rounded-full shadow-lg shadow-primary/25"
                  disabled={loading}
                  onClick={handleSubmit}
                >
                  {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CreditCard className="h-5 w-5" />}
                  {loading ? 'Conectando con el pago…' : 'Ir a pagar'}
                </Button>
              </PressScale>
            </div>
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Pago seguro. No se cobra hasta confirmar en la pasarela. Si algo falla al conectar, no se crea un
              cobro duplicado.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* CTA sticky móvil */}
      <div
        className="sticky-purchase-bar fixed bottom-0 inset-x-0 z-40 md:hidden border-t border-border/60 bg-background/95 backdrop-blur-xl shadow-[0_-8px_24px_-8px_rgb(0_0_0_/0.35)] transition-[bottom] duration-200"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="max-w-[1200px] mx-auto px-4 pt-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {totalItems} entrada{totalItems !== 1 ? 's' : ''}
            </p>
            <p className="font-display text-xl font-bold tabular-nums leading-none">{totalPrice.toFixed(2)}€</p>
          </div>
          <Button
            size="lg"
            className="gap-2 font-display font-semibold rounded-full shadow-lg shadow-primary/25 h-12 px-5 shrink-0"
            disabled={loading}
            onClick={handleSubmit}
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CreditCard className="h-5 w-5" />}
            {loading ? 'Pago…' : 'Ir a pagar'}
          </Button>
        </div>
        <p className="px-4 pt-2 text-xs text-muted-foreground flex items-center gap-1">
          <Lock className="h-3 w-3 shrink-0" />
          Pago seguro · QR por email
        </p>
      </div>
    </FadeIn>
  );
}
