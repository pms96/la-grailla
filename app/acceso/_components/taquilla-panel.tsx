'use client';

import { useMemo, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Minus, Plus, Loader2, Banknote, CreditCard, Gift, CheckCircle2, DoorOpen, Printer, Bluetooth, BluetoothOff } from 'lucide-react';
import { toast } from 'sonner';
import { usePhomemoPrinter } from '@/lib/phomemo/use-phomemo-printer';
import type { PhomemoWriteMode } from '@/lib/phomemo/constants';
import type { EventWithTicketTypes } from './access-client';

type Props = { events: EventWithTicketTypes[]; selectedEvent: string; onSold?: () => void };

type LastSale = { orderId: string; totalAmount: number; tickets: number; duringEvent: boolean };

const WRITE_MODE_LABELS: Record<PhomemoWriteMode, string> = {
  auto: 'Auto',
  with_response: 'Siempre confirmado',
  without_response: 'Siempre sin confirmar',
};

export default function TaquillaPanel({ events, selectedEvent, onSold }: Props) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [buyerName, setBuyerName] = useState('');
  const [buyerLastName, setBuyerLastName] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [duringEvent, setDuringEvent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastSale, setLastSale] = useState<LastSale | null>(null);
  const [printing, setPrinting] = useState(false);
  const printer = usePhomemoPrinter();
  // Se manda al servidor para que un reintento de red tras un timeout (o un
  // doble tap en el datáfono) no cobre ni emita entradas dos veces — se
  // renueva solo tras una venta completada o si el usuario cambia de evento
  // sin llegar a vender, nunca durante el mismo intento en curso.
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const event = useMemo(() => (events ?? []).find((e) => e?.id === selectedEvent), [events, selectedEvent]);
  const ticketTypes = event?.ticketTypes ?? [];

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
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data?.error ?? 'Error al registrar la venta'); return; }

      setLastSale(data);
      idempotencyKeyRef.current = crypto.randomUUID();
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

  const sharePdfFallback = async (pdfBlob: Blob, orderId: string) => {
    const file = new File([pdfBlob], `entradas-${orderId.slice(0, 8)}.pdf`, { type: 'application/pdf' });
    const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';
    if (canShareFiles && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Entradas' });
      return;
    }
    window.open('/api/taquilla/print/' + orderId, '_blank', 'noreferrer');
  };

  const handleConnectPrinter = async () => {
    if (printer.status === 'connected') {
      printer.disconnect();
      toast.message('Impresora desconectada');
      return;
    }
    try {
      const name = await printer.connect();
      toast.success('Conectada: ' + name);
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') return;
      toast.error(e instanceof Error ? e.message : 'No se pudo conectar la impresora');
    }
  };

  const handlePrint = async () => {
    if (!lastSale) return;
    setPrinting(true);
    try {
      const res = await fetch('/api/taquilla/print/' + lastSale.orderId);
      if (!res.ok) { toast.error('No se pudo generar el tique'); return; }
      const blob = await res.blob();

      if (printer.bleAvailable) {
        try {
          await printer.printPdfBytes(await blob.arrayBuffer(), (current, total) => {
            toast.loading(total > 1 ? `Imprimiendo ${current} de ${total}…` : 'Imprimiendo…', { id: 'phomemo-print' });
          });
          toast.success(lastSale.tickets === 1 ? 'Entrada impresa' : `${lastSale.tickets} entradas impresas`, { id: 'phomemo-print' });
          return;
        } catch (e) {
          toast.dismiss('phomemo-print');
          if (e instanceof Error && (e.message === 'cancelled' || e.name === 'AbortError')) return;
          toast.error(e instanceof Error ? e.message : 'La impresora no respondió');
          toast.message('Se abre el PDF para imprimir o compartir.');
        }
      } else if (printer.isIOS) {
        toast.message('En iPhone usa Bluefy para imprimir directo. Mientras, comparte el PDF.');
      }
      await sharePdfFallback(blob, lastSale.orderId);
    } catch (e) {
      if (e instanceof Error && (e.message === 'cancelled' || e.name === 'AbortError')) return;
      toast.error(e instanceof Error ? e.message : 'No se pudo imprimir');
    } finally {
      setPrinting(false);
    }
  };

  if (!event) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Selecciona un evento para vender entradas.</CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            {printer.status === 'connected' ? (
              <Bluetooth className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            ) : (
              <BluetoothOff className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {printer.status === 'connected'
                  ? `Phomemo ${printer.deviceName ?? 'M04S'}`
                  : printer.status === 'connecting'
                    ? 'Conectando impresora…'
                    : 'Impresora Phomemo M04S'}
              </p>
              <p className="text-xs text-muted-foreground">
                {printer.status === 'connected'
                  ? 'Lista. El botón Imprimir manda el tique directo, sin la app de Phomemo. Papel 110 mm.'
                  : printer.status === 'unsupported' && printer.isIOS
                    ? (
                      <>
                        Safari, Chrome y Brave en iPhone no pueden usar Bluetooth. Abre esta misma página en{' '}
                        <a
                          href="https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055"
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline underline-offset-2"
                        >
                          Bluefy
                        </a>
                        .
                      </>
                    )
                    : printer.status === 'unsupported'
                      ? 'Este navegador no admite Web Bluetooth. En Android usa Chrome; en iPhone, Bluefy.'
                      : 'Conéctala al empezar el turno. Papel 110 mm (entrada 105 × 70).'}
              </p>
            </div>
          </div>
          {printer.bleAvailable && (
            <Button
              type="button"
              variant={printer.status === 'connected' ? 'outline' : 'default'}
              size="sm"
              className="shrink-0"
              onClick={handleConnectPrinter}
              disabled={printer.status === 'connecting'}
            >
              {printer.status === 'connecting' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : printer.status === 'connected' ? (
                'Desconectar'
              ) : (
                'Conectar'
              )}
            </Button>
          )}
        </CardContent>
      </Card>

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
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                  <a href={'/api/tickets/' + lastSale?.orderId + '/pdf-html'} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">Ver entradas para imprimir</a>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5 h-7" onClick={handlePrint} disabled={printing}>
                    {printing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                    Imprimir entrada{(lastSale?.tickets ?? 0) !== 1 ? 's' : ''}
                  </Button>
                </div>
              )}
              {printer.lastDiagnostics && (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">
                    Detalles técnicos de la impresión
                    {printer.lastDiagnostics.error && <span className="text-destructive"> · con errores</span>}
                  </summary>
                  <div className="mt-1.5 space-y-0.5 pl-3 border-l border-border">
                    <p>Modo: {WRITE_MODE_LABELS[printer.lastDiagnostics.writeModeRequested]}</p>
                    <p>
                      Escrituras confirmadas: {printer.lastDiagnostics.chunksWithResponse} · sin confirmar:{' '}
                      {printer.lastDiagnostics.chunksWithoutResponse}
                    </p>
                    {printer.lastDiagnostics.retries > 0 && (
                      <p className="text-amber-600">
                        Reintentos por fallo silencioso: {printer.lastDiagnostics.retries} (Auto pasó a modo confirmado a
                        mitad de impresión)
                      </p>
                    )}
                    <p>Suscrita a notificaciones de la impresora: {printer.lastDiagnostics.notifySubscribed ? 'sí' : 'no'}</p>
                    <p>
                      Confirmación de escritura real del navegador:{' '}
                      {printer.lastDiagnostics.explicitConfirmedWriteSupported ? 'sí' : 'no (solo API antigua ambigua)'}
                    </p>
                    <p>
                      Páginas: {printer.lastDiagnostics.pages}/{printer.lastDiagnostics.totalPages} ·{' '}
                      {printer.lastDiagnostics.rasterChunks} bloques de datos
                    </p>
                    <p>Duración: {(printer.lastDiagnostics.durationMs / 1000).toFixed(1)}s</p>
                    {printer.lastDiagnostics.error && <p className="text-destructive">Error: {printer.lastDiagnostics.error}</p>}
                  </div>
                </details>
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
