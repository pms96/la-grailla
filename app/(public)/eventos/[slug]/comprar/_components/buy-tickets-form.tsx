'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Ticket, Minus, Plus, CreditCard, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn } from '@/components/ui/animate';

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
  ticketTypes: TicketType[];
}

export default function BuyTicketsForm({ event, queueToken }: { event: EventData; queueToken?: string }) {
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [buyerName, setBuyerName] = useState('');
  const [buyerLastName, setBuyerLastName] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const ticketTypes = event?.ticketTypes ?? [];

  const updateQty = (id: string, delta: number) => {
    setQuantities((prev) => {
      const current = prev?.[id] ?? 0;
      const tt = ticketTypes?.find((t: TicketType) => t?.id === id);
      const available = (tt?.maxQuantity ?? 0) - (tt?.soldCount ?? 0);
      const next = Math.max(0, Math.min(current + delta, Math.min(available, 10)));
      return { ...(prev ?? {}), [id]: next };
    });
  };

  const totalItems = Object.values(quantities ?? {}).reduce((s: number, q: number) => s + (q ?? 0), 0);
  const totalPrice = ticketTypes.reduce((s: number, tt: TicketType) => {
    return s + ((tt?.price ?? 0) * (quantities?.[tt?.id] ?? 0));
  }, 0);

  const handleSubmit = async () => {
    if (!buyerName?.trim() || !buyerLastName?.trim() || !buyerEmail?.trim()) {
      toast.error('Completa todos los campos');
      return;
    }
    if (totalItems === 0) {
      toast.error('Selecciona al menos una entrada');
      return;
    }

    setLoading(true);
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
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.success) {
        toast.error(data?.error ?? 'Error al procesar la compra');
        return;
      }
      if (data?.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      router.push(`/confirmacion/${data.orderId}`);
    } catch {
      toast.error('Error de conexión');
    } finally {
      setLoading(false);
    }
  };

  return (
    <FadeIn>
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">🎫 Comprar Entradas</h1>
          <p className="text-muted-foreground mt-1">{event?.name ?? ''} — ¡Asegura tu plaza!</p>
        </div>

        <Card>
          <CardContent className="p-6">
            <h2 className="font-display font-bold text-lg mb-4 flex items-center gap-2">
              <Ticket className="h-5 w-5 text-primary" /> Selecciona tus entradas
            </h2>
            <div className="space-y-4">
              {ticketTypes.map((tt: TicketType) => {
                const available = (tt?.maxQuantity ?? 0) - (tt?.soldCount ?? 0);
                const qty = quantities?.[tt?.id] ?? 0;
                const soldOut = available <= 0;
                return (
                  <div key={tt?.id} className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{tt?.name ?? ''}</p>
                        {tt?.phaseName && <Badge variant="outline" className="text-xs">{tt.phaseName}</Badge>}
                      </div>
                      {tt?.description && <p className="text-xs text-muted-foreground mt-1">{tt.description}</p>}
                      <p className="font-bold text-primary mt-1">{(tt?.price ?? 0).toFixed(2)}€</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {soldOut ? (
                        <Badge variant="destructive">Agotado</Badge>
                      ) : (
                        <>
                          <Button variant="outline" size="icon-sm" onClick={() => updateQty(tt?.id, -1)} disabled={qty <= 0}>
                            <Minus className="h-3 w-3" />
                          </Button>
                          <span className="w-8 text-center font-mono font-bold">{qty}</span>
                          <Button variant="outline" size="icon-sm" onClick={() => updateQty(tt?.id, 1)} disabled={qty >= available}>
                            <Plus className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h2 className="font-display font-bold text-lg">Datos del comprador</h2>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="name">Nombre</Label>
                <Input id="name" value={buyerName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBuyerName(e?.target?.value ?? '')} placeholder="Tu nombre" className="mt-1" />
              </div>
              <div>
                <Label htmlFor="lastName">Apellidos</Label>
                <Input id="lastName" value={buyerLastName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBuyerLastName(e?.target?.value ?? '')} placeholder="Tus apellidos" className="mt-1" />
              </div>
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={buyerEmail} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBuyerEmail(e?.target?.value ?? '')} placeholder="tu@email.com" className="mt-1" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <p className="text-sm text-muted-foreground">{totalItems} entrada{totalItems !== 1 ? 's' : ''}</p>
                <p className="font-display text-2xl font-bold">{totalPrice.toFixed(2)}€</p>
              </div>
              <Button size="lg" className="gap-2" disabled={loading || totalItems === 0} onClick={handleSubmit}>
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CreditCard className="h-5 w-5" />}
                {loading ? 'Conectando con el pago...' : 'Ir a pagar'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Pagarás en un entorno seguro. Al confirmar el pago, aceptas las condiciones del evento y recibirás tus entradas por email.</p>
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}
