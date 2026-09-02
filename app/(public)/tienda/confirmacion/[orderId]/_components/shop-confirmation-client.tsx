'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle, Clock, Package, XCircle, Loader2 } from 'lucide-react';
import { ReceiptPrinter, usePrintSequence } from '@/components/receipt-printer';

type ShopOrderView = {
  id: string;
  status: string;
  buyerName: string;
  buyerEmail: string;
  totalAmount: number;
  shippingAddress: string;
  shippingCity: string;
  shippingZip: string;
  shippingPhone: string | null;
  items: {
    id: string;
    quantity: number;
    unitPrice: number;
    size: string | null;
    color: string | null;
    product: { name: string } | null;
  }[];
};

export default function ShopConfirmationClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<ShopOrderView | null>(null);
  const [loading, setLoading] = useState(true);
  const [pollCount, setPollCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/shop/orders/${orderId}`);
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
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!order || order.status !== 'PENDING' || pollCount >= 12) return;
    const t = setTimeout(() => {
      setPollCount((c) => c + 1);
      void load();
    }, 2500);
    return () => clearTimeout(t);
  }, [order, pollCount, load]);

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

  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
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
  return (
    <div className="space-y-6 py-8">
      <div className="text-center">
        <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
        <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Pedido confirmado</h1>
        <p className="text-muted-foreground mt-2">
          Te hemos enviado un email de confirmación a {order.buyerEmail}
        </p>
      </div>

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
function ShopReceiptPrinter({ order }: { order: ShopOrderView }) {
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
            <p className="text-xs tracking-[0.2em] text-black/45">LA GRAILLA · RECIBO</p>
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
          <ReceiptPrinter.DashedRule />
          <p className="text-xs font-bold uppercase tracking-wide text-black">Dirección de envío</p>
          <div className="mt-1.5 space-y-0.5 text-xs text-black/70">
            <p>{order.buyerName}</p>
            <p>{order.shippingAddress}</p>
            <p>{order.shippingZip} {order.shippingCity}</p>
            {order.shippingPhone && <p>{order.shippingPhone}</p>}
          </div>
          <p className="mt-4 text-center text-xs text-black/40">¡Nos vemos en la caseta! 🍻</p>
        </ReceiptPrinter.Paper>
      </ReceiptPrinter.Output>
    </ReceiptPrinter.Root>
  );
}
