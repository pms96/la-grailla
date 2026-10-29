'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle, Clock, Mail, Package, XCircle, Loader2 } from 'lucide-react';
import { ReceiptPrinter, usePrintSequence } from '@/components/receipt-printer';
import { useBrand } from '@/components/brand-provider';
import { FiscalFootnote } from '@/components/fiscal-footnote';
import type { FiscalView } from '@/lib/fiscal';
import { cartMatchesOrderItems, readCart, writeCart } from '@/lib/shop-cart';
import { confirmationView, emailNotice, shouldKeepPolling, type EmailDelivery, type PaymentCheck } from '@/lib/confirmation-state';

export type ShopOrderView = {
  id: string;
  status: string;
  buyerName: string;
  buyerEmail: string;
  totalAmount: number;
  /** Id del pago en la pasarela: si existe, un pedido cancelado puede tener un cobro en camino (pago tardío). */
  paymentId?: string | null;
  /** Resultado de comprobar contra la pasarela un pedido anulado con pago (lo añade la API del pedido). */
  paymentCheck?: PaymentCheck;
  /** Estado REAL del email de confirmación (lo calcula la API del pedido): la pantalla no afirma haberlo enviado sin comprobarlo. */
  emailDelivery?: EmailDelivery | null;
  /** Vendedor e IVA del justificante (lo añade la API del pedido con el pedido pagado). */
  fiscal?: FiscalView | null;
  /** Número de seguimiento que puso el vendedor al enviarlo (lo devuelve la API del pedido). */
  trackingNumber?: string | null;
  shippingAddress: string;
  shippingCity: string;
  shippingZip: string;
  shippingPhone: string | null;
  items: {
    id: string;
    productId?: string;
    quantity: number;
    unitPrice: number;
    size: string | null;
    color: string | null;
    product: { name: string } | null;
  }[];
};

const MAX_POLLS = 12;
// Mientras el email está «enviándose» o «reintentándose» se vuelve a preguntar (no es el sondeo del pago): cada 5 s, hasta un minuto.
const MAX_EMAIL_POLLS = 12;
const EMAIL_POLL_INTERVAL_MS = 5000;

export default function ShopConfirmationClient({ orderId, accessToken }: { orderId: string; accessToken?: string }) {
  const [order, setOrder] = useState<ShopOrderView | null>(null);
  const [loading, setLoading] = useState(true);
  const [pollCount, setPollCount] = useState(0);
  const [emailPollCount, setEmailPollCount] = useState(0);
  const [resend, setResend] = useState<'idle' | 'sending' | 'queued' | 'error' | 'limited'>('idle');
  const tokenQs = accessToken ? `?t=${encodeURIComponent(accessToken)}` : '';

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/shop/orders/${orderId}${tokenQs}`);
      if (!res.ok) {
        setOrder(null);
        return;
      }
      const data = await res.json();
      setOrder(data);
    } catch {
      // keep previous
    } finally {
      setLoading(false);
    }
  }, [orderId, tokenQs]);

  useEffect(() => {
    void load();
  }, [load]);

  // Qué debe decir la pantalla (decisión pura, compartida con entradas): «no se ha cobrado nada» solo si la pasarela lo confirma.
  const view = order ? confirmationView({ status: order.status, paymentId: order.paymentId, paymentCheck: order.paymentCheck, pollsExhausted: pollCount >= MAX_POLLS }) : null;

  // El carrito se vacía AQUÍ, cuando el pedido consta como pagado (no al pulsar «Pagar»), y solo si lo guardado es el de este pedido.
  useEffect(() => {
    if (!order || !['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) return;
    const items = (order.items ?? []).filter((i): i is typeof i & { productId: string } => typeof i.productId === 'string');
    if (items.length === order.items.length && cartMatchesOrderItems(readCart(), items)) writeCart([]);
  }, [order]);

  useEffect(() => {
    if (!view || !shouldKeepPolling(view) || pollCount >= MAX_POLLS) return;
    const t = setTimeout(() => {
      setPollCount((c) => c + 1);
      void load();
    }, 2500);
    return () => clearTimeout(t);
  }, [view, pollCount, load]);

  // El servidor envía el email por su cuenta (y lo reintenta): aquí solo se refleja el estado real, preguntando de nuevo mientras pueda cambiar.
  const emailPolling = emailNotice({ delivery: order?.emailDelivery, kind: 'tienda', email: '' }).keepPolling;
  useEffect(() => {
    if (view !== 'confirmed' || !emailPolling || emailPollCount >= MAX_EMAIL_POLLS) return;
    const t = setTimeout(() => {
      setEmailPollCount((c) => c + 1);
      void load();
    }, EMAIL_POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [view, emailPolling, emailPollCount, load]);

  const resendEmail = async () => {
    setResend('sending');
    try {
      const res = await fetch(`/api/shop/orders/${orderId}/send-email${tokenQs}`, { method: 'POST' });
      if (res.status === 429) {
        setResend('limited');
        return;
      }
      const data = await res.json().catch(() => null);
      setResend(data?.success ? 'queued' : 'error');
      setEmailPollCount(0);
      void load();
    } catch {
      setResend('error');
    }
  };

  if (loading && !order) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20" role="status">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Cargando pedido…</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-16 space-y-4">
        <XCircle className="h-12 w-12 text-destructive mx-auto" />
        <h1 className="font-display text-2xl font-bold">Pedido no encontrado</h1>
        <Button asChild variant="outline">
          <Link href="/tienda">Volver a la tienda</Link>
        </Button>
      </div>
    );
  }

  if (view === 'checking' || view === 'checking_gave_up') {
    const gaveUp = view === 'checking_gave_up';
    const code = order.id.slice(0, 8).toUpperCase();
    return (
      <div className="space-y-6 py-8">
        <div className="text-center">
          <Clock className="h-16 w-16 text-yellow-500 mx-auto mb-4" />
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Estamos comprobando tu pago…</h1>
          <p className="text-muted-foreground mt-2 max-w-md mx-auto">
            {gaveUp ? (
              <>
                Todavía no hemos podido confirmar tu pago. Si has pagado y no ves tu compra, escríbenos indicando este código:{' '}
                <strong className="font-mono">{code}</strong>. Si no se confirma, te devolveremos el importe.
              </>
            ) : (
              'La reserva de tu pedido había caducado. Si has pagado, lo estamos comprobando: recibirás tu pedido o te devolveremos el importe automáticamente, y te avisaremos por email. No hace falta que vuelvas a pagar.'
            )}
          </p>
          {!gaveUp && <Loader2 className="h-5 w-5 animate-spin text-primary mx-auto mt-4" />}
        </div>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Referencia #{code} · {order.totalAmount.toFixed(2)}€
          </CardContent>
        </Card>
      </div>
    );
  }

  if (view === 'refunded') {
    return (
      <div className="space-y-6 py-8">
        <div className="text-center">
          <XCircle className="h-16 w-16 text-destructive mx-auto mb-4" />
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Te hemos devuelto el pago</h1>
          <p className="text-muted-foreground mt-2">
            Este pedido no se ha podido completar y te hemos devuelto el importe ({order.totalAmount.toFixed(2)}€). Puede tardar unos días en
            aparecer en tu cuenta.
          </p>
        </div>
        <div className="flex justify-center">
          <Button asChild>
            <Link href="/tienda/checkout">Volver al checkout</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (view === 'not_charged') {
    return (
      <div className="space-y-6 py-8">
        <div className="text-center">
          <XCircle className="h-16 w-16 text-destructive mx-auto mb-4" />
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Pedido no completado</h1>
          <p className="text-muted-foreground mt-2">
            Este pedido se ha cancelado o no se ha podido cobrar. No se ha realizado ningún cargo.
          </p>
        </div>
        <div className="flex justify-center">
          <Button asChild>
            <Link href="/tienda/checkout">Volver al checkout</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (order.status === 'PENDING') {
    return (
      <div className="space-y-6 py-8">
        <div className="text-center">
          <Clock className="h-16 w-16 text-yellow-500 mx-auto mb-4" />
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Confirmando el pago…</h1>
          <p className="text-muted-foreground mt-2">
            Estamos esperando la confirmación de la pasarela. Esto suele tardar unos segundos.
          </p>
          <Loader2 className="h-5 w-5 animate-spin text-primary mx-auto mt-4" />
        </div>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Referencia #{order.id.slice(0, 8).toUpperCase()} · {order.totalAmount.toFixed(2)}€
          </CardContent>
        </Card>
      </div>
    );
  }

  // PAID / PROCESSING / SHIPPED / DELIVERED
  const notice = emailNotice({ delivery: order.emailDelivery, kind: 'tienda', email: order.buyerEmail });
  return (
    <div className="space-y-6 py-8">
      <div className="text-center">
        <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
        <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Pedido confirmado</h1>
        <p className="text-muted-foreground mt-2">Hemos recibido tu pago.</p>
      </div>

      {(order.status === 'PROCESSING' || order.status === 'SHIPPED' || order.status === 'DELIVERED') && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3">
            <Package className="h-5 w-5 mt-0.5 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="font-medium leading-tight">
                {order.status === 'PROCESSING' ? 'Estamos preparando tu pedido' : order.status === 'SHIPPED' ? 'Tu pedido ya ha salido' : 'Tu pedido ha sido entregado'}
              </p>
              {order.trackingNumber?.trim() && order.status !== 'PROCESSING' && (
                <p className="text-sm text-muted-foreground">Seguimiento: <span className="font-mono text-foreground">{order.trackingNumber.trim()}</span></p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3" role="status" aria-live="polite">
            <Mail className={`h-5 w-5 mt-0.5 shrink-0 ${notice.tone === 'problem' ? 'text-destructive' : 'text-primary'}`} />
            <div>
              <p className="font-medium leading-tight">{notice.title}</p>
              <p className="text-sm text-muted-foreground">{notice.detail}</p>
              {resend === 'queued' && <p className="text-sm text-muted-foreground mt-1">Hecho: te lo estamos enviando de nuevo.</p>}
              {resend === 'error' && <p className="text-sm text-destructive mt-1">No hemos podido reenviarlo ahora. Guarda esta página: es tu justificante.</p>}
              {resend === 'limited' && <p className="text-sm text-destructive mt-1">Has pedido demasiados reenvíos de este pedido. Prueba de nuevo más tarde.</p>}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={resendEmail} disabled={resend === 'sending'} className="gap-2 shrink-0">
            {resend === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            Reenviar a mi email
          </Button>
        </CardContent>
      </Card>

      <ShopReceiptPrinter order={order} />

      <div className="flex justify-center">
        <Button asChild variant="outline">
          <Link href="/tienda">Volver a la tienda</Link>
        </Button>
      </div>
    </div>
  );
}

/** Recibo imprimiéndose con los artículos y el envío del pedido de tienda. */
export function ShopReceiptPrinter({ order }: { order: ShopOrderView }) {
  const { name, legacy } = useBrand();
  const stage = usePrintSequence(true);
  const shortCode = order.id.slice(0, 8).toUpperCase();

  return (
    <ReceiptPrinter.Root stage={stage}>
      <ReceiptPrinter.Machine orderCode={shortCode}>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 font-mono text-xs">
            <span className="truncate text-white/70">Pedido de tienda</span>
            <span className="shrink-0 font-bold text-white">{order.totalAmount.toFixed(2)}€</span>
          </div>
          <ReceiptPrinter.Status />
        </div>
      </ReceiptPrinter.Machine>
      <ReceiptPrinter.Output>
        <ReceiptPrinter.Paper>
          <header className="text-center">
            <p className="text-xs tracking-[0.2em] text-black/45">{name.toUpperCase()} · JUSTIFICANTE</p>
            <h3 className="mt-1 font-display text-base font-bold leading-tight text-black">
              Pedido #{shortCode}
            </h3>
          </header>
          <ReceiptPrinter.DashedRule />
          <div className="flex items-center gap-2">
            <Package className="h-3.5 w-3.5 text-black/60" />
            <p className="text-xs font-bold uppercase tracking-wide text-black">Artículos</p>
          </div>
          <div className="mt-2 space-y-1.5">
            {(order.items ?? []).map((item) => (
              <div key={item.id} className="flex justify-between gap-2 text-xs">
                <span className="text-black/70">
                  {item.quantity} x {item.product?.name ?? ''}
                  {[item.size, item.color].filter(Boolean).length > 0
                    ? ' (' + [item.size, item.color].filter(Boolean).join(', ') + ')'
                    : ''}
                </span>
                <span className="shrink-0 text-black">{(item.unitPrice * item.quantity).toFixed(2)}€</span>
              </div>
            ))}
          </div>
          <ReceiptPrinter.DashedRule />
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-black/60">Total</span>
            <span className="font-display text-lg font-bold text-black">{order.totalAmount.toFixed(2)}€</span>
          </div>
          <FiscalFootnote fiscal={order.fiscal} tone="paper" className="mt-1.5" />
          <ReceiptPrinter.DashedRule />
          <p className="text-xs font-bold uppercase tracking-wide text-black">Dirección de envío</p>
          <div className="mt-1.5 space-y-0.5 text-xs text-black/70">
            <p>{order.buyerName}</p>
            <p>{order.shippingAddress}</p>
            <p>{order.shippingZip} {order.shippingCity}</p>
            {order.shippingPhone && <p>{order.shippingPhone}</p>}
          </div>
          <p className="mt-4 text-center text-xs text-black/40">{legacy ? '¡Nos vemos en la caseta! 🍻' : 'Gracias por tu compra'}</p>
        </ReceiptPrinter.Paper>
      </ReceiptPrinter.Output>
    </ReceiptPrinter.Root>
  );
}
