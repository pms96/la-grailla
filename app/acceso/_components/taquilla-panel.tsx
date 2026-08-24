'use client';

import { useMemo, useState } from 'react';
import type { TicketType } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Minus, Plus, Loader2, Banknote, CreditCard, Gift, CheckCircle2, DoorOpen } from 'lucide-react';
import { toast } from 'sonner';
import type { EventWithTicketTypes } from './access-client';

type Props = { events: EventWithTicketTypes[]; selectedEvent: string; onSold?: () => void };

type LastSale = { orderId: string; totalAmount: number; tickets: number; duringEvent: boolean };

export default function TaquillaPanel({ events, selectedEvent, onSold }: Props) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [buyerName, setBuyerName] = useState('');
  const [buyerLastName, setBuyerLastName] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [duringEvent, setDuringEvent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastSale, setLastSale] = useState<LastSale | null>(null);

  const event = useMemo(() => (events ?? []).find((e) => e?.id === selectedEvent), [events, selectedEvent]);
  const ticketTypes: TicketType[] = event?.ticketTypes ?? [];

  let totalTickets = 0;
  let total = 0;
  for (const tt of ticketTypes) {
    const q = quantities?.[tt?.id] ?? 0;
    totalTickets += q;
    total += q * (tt?.price ?? 0);
  }
  if (paymentMethod === 'free') total = 0;

  const changeQty = (id: string, delta: number) => {
    setQuantities((prev) => {
      const next = Math.max(0, (prev?.[id] ?? 0) + delta);
      return { ...(prev ?? {}), [id]: next };
    });
  };

  const reset = () => {
    setQuantities({});
    setBuyerName('');
    setBuyerLastName('');
    setBuyerEmail('');
  };

  const handleSubmit = async () => {
    if (!selectedEvent) { toast.error('Selecciona un evento'); return; }
    if (!duringEvent && !buyerName.trim()) { toast.error('Introduce el nombre del comprador'); return; }
    if (totalTickets < 1) { toast.error('Selecciona al menos una entrada'); return; }

    setSubmitting(true);
    try {
      const items = ticketTypes
        .filter((tt) => (quantities?.[tt?.id] ?? 0) > 0)
        .map((tt) => ({ ticketTypeId: tt.id, quantity: quantities[tt.id] }));

      const res = await fetch('/api/taquilla/sale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: selectedEvent,
          buyerName: buyerName.trim(),
          buyerLastName: buyerLastName.trim(),
          buyerEmail: buyerEmail.trim(),
          items,
          paymentMethod,
          duringEvent,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data?.error ?? 'Error al registrar la venta'); return; }

      setLastSale(data);
      toast.success(duringEvent ? 'Acceso concedido' : 'Venta registrada');
      const hadEmail = !duringEvent && buyerEmail.trim();
      reset();
      onSold?.();

      if (hadEmail) {
        fetch('/api/orders/' + data.orderId + '/send-tickets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        }).catch(() => {});
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSubmitting(false);
    }
  };

  if (!event) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Selecciona un evento para vender entradas.</CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      {lastSale && (
        <Card className="border-green-500/40 bg-green-500/5">
          <CardContent className="p-4 flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold">
                {lastSale?.duringEvent ? 'Acceso concedido' : 'Venta completada'} · {lastSale?.tickets ?? 0} entrada(s)
              </p>
              <p className="text-muted-foreground">Importe: {(lastSale?.totalAmount ?? 0).toFixed(2)} €</p>
              {!lastSale?.duringEvent && (
                <a href={'/api/tickets/' + lastSale?.orderId + '/pdf-html'} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">Ver entradas para imprimir</a>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className={duringEvent ? 'border-primary/40' : ''}>
        <CardContent className="p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <DoorOpen className="h-4 w-4 text-primary" />
            <div>
              <p className="text-sm font-medium">El evento ya ha empezado</p>
              <p className="text-xs text-muted-foreground">La persona entra directamente: no se pide nombre ni se envía email, y se suma ya al aforo.</p>
            </div>
          </div>
          <Switch checked={duringEvent} onCheckedChange={setDuringEvent} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-semibold text-sm">Entradas</h3>
          {ticketTypes.length === 0 && <p className="text-sm text-muted-foreground">Este evento no tiene tipos de entrada activos.</p>}
          {ticketTypes.map((tt) => {
            const remaining = (tt?.maxQuantity ?? 0) - (tt?.soldCount ?? 0);
            return (
              <div key={tt?.id} className="flex items-center justify-between gap-3 border-b border-border last:border-0 pb-3 last:pb-0">
                <div className="min-w-0">
                  <p className="font-medium truncate">{tt?.name ?? ''}</p>
                  <p className="text-xs text-muted-foreground">{(tt?.price ?? 0).toFixed(2)} € · quedan {remaining}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="icon-sm" onClick={() => changeQty(tt.id, -1)} disabled={(quantities?.[tt.id] ?? 0) === 0}><Minus className="h-4 w-4" /></Button>
                  <span className="w-6 text-center font-semibold">{quantities?.[tt.id] ?? 0}</span>
                  <Button variant="outline" size="icon-sm" onClick={() => changeQty(tt.id, 1)} disabled={(quantities?.[tt.id] ?? 0) >= remaining}><Plus className="h-4 w-4" /></Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          {!duringEvent && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><Label>Nombre *</Label><Input value={buyerName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBuyerName(e?.target?.value ?? '')} className="mt-1" /></div>
                <div><Label>Apellidos</Label><Input value={buyerLastName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBuyerLastName(e?.target?.value ?? '')} className="mt-1" /></div>
              </div>
              <div>
                <Label>Email (opcional)</Label>
                <Input type="email" value={buyerEmail} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBuyerEmail(e?.target?.value ?? '')} className="mt-1" placeholder="Se le enviarán las entradas por email" />
              </div>
            </>
          )}
          <div>
            <Label>Método de pago</Label>
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Efectivo</SelectItem>
                <SelectItem value="card">Tarjeta (datáfono)</SelectItem>
                <SelectItem value="free">Invitación / gratuita</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="border-primary/30">
        <CardContent className="p-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground">{totalTickets} entrada(s)</p>
            <p className="text-2xl font-bold">{total.toFixed(2)} €</p>
          </div>
          <Button onClick={handleSubmit} disabled={submitting || totalTickets < 1} className="gap-2">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : paymentMethod === 'cash' ? <Banknote className="h-4 w-4" /> : paymentMethod === 'card' ? <CreditCard className="h-4 w-4" /> : <Gift className="h-4 w-4" />}
            {duringEvent ? 'Cobrar y dar acceso' : 'Cobrar y emitir'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
