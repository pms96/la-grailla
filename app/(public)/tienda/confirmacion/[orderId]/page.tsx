export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { Container } from '@/components/layouts/container';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle, Package } from 'lucide-react';

export default async function ShopConfirmationPage({ params }: { params: { orderId: string } }) {
  const order = await prisma.shopOrder.findUnique({
    where: { id: params?.orderId },
    include: { items: { include: { product: true } } },
  });

  if (!order) notFound();

  return (
    <Container size="md">
      <div className="py-12 space-y-6">
        <div className="text-center">
          <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Pedido confirmado</h1>
          <p className="text-muted-foreground mt-2">
            Te hemos enviado un email de confirmación a {order.buyerEmail}
          </p>
        </div>

        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-primary" />
              <h2 className="font-display font-bold text-lg">
                Pedido #{order.id.slice(0, 8).toUpperCase()}
              </h2>
            </div>
            <div className="space-y-2">
              {(order.items ?? []).map((item) => (
                <div key={item.id} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {item.quantity} x {item.product?.name ?? ''}
                    {[item.size, item.color].filter(Boolean).length > 0
                      ? ' (' + [item.size, item.color].filter(Boolean).join(', ') + ')'
                      : ''}
                  </span>
                  <span>{(item.unitPrice * item.quantity).toFixed(2)}€</span>
                </div>
              ))}
              <div className="flex justify-between border-t pt-2 font-bold">
                <span>Total</span>
                <span>{order.totalAmount.toFixed(2)}€</span>
              </div>
            </div>
            <div className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground mb-1">Dirección de envío</p>
              <p>{order.buyerName}</p>
              <p>{order.shippingAddress}</p>
              <p>
                {order.shippingZip} {order.shippingCity}
              </p>
              {order.shippingPhone && <p>{order.shippingPhone}</p>}
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link href="/tienda">Volver a la tienda</Link>
          </Button>
        </div>
      </div>
    </Container>
  );
}
