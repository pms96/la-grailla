'use client';

import { useEffect, useState } from 'react';
import type { Prisma, ShopOrderStatus } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Loader2, Package, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';

const statusLabels: Record<string, string> = {
  PENDING: 'Pendiente', PAID: 'Pagado', PROCESSING: 'Procesando',
  SHIPPED: 'Enviado', DELIVERED: 'Entregado', CANCELLED: 'Cancelado', REFUNDED: 'Reembolsado',
};

type ShopOrderWithItems = Prisma.ShopOrderGetPayload<{ include: { items: { include: { product: true } } } }>;

export default function PedidosPage() {
  const [orders, setOrders] = useState<ShopOrderWithItems[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOrders = () => {
    fetch('/api/admin/shop-orders')
      .then((r) => r.json())
      .then((d) => setOrders(d ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOrders(); }, []);

  const updateOrder = async (id: string, data: Partial<Pick<ShopOrderWithItems, 'status' | 'trackingNumber'>>) => {
    try {
      await fetch(`/api/admin/shop-orders/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      toast.success('Actualizado');
      fetchOrders();
    } catch { toast.error('Error'); }
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Pedidos de Tienda" description="Gestiona los pedidos de merchandising" />

      {(orders?.length ?? 0) === 0 ? (
        <p className="text-center py-20 text-muted-foreground">No hay pedidos aún</p>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <Card key={order?.id}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{order?.buyerName ?? ''}</p>
                    <p className="text-xs text-muted-foreground">{order?.buyerEmail ?? ''} · {order?.createdAt ? new Date(order.createdAt).toLocaleDateString('es-ES') : ''}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge>{statusLabels[order?.status ?? ''] ?? order?.status}</Badge>
                    <span className="font-bold text-primary">{(order?.totalAmount ?? 0).toFixed(2)}€</span>
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">
                  <p><Package className="h-3 w-3 inline mr-1" /> {(order?.items ?? []).map((i) => `${i?.product?.name ?? ''} x${i?.quantity ?? 0}`).join(', ')}</p>
                  <p><Truck className="h-3 w-3 inline mr-1" /> {order?.shippingAddress ?? ''}, {order?.shippingCity ?? ''} {order?.shippingZip ?? ''}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Select value={order?.status ?? ''} onValueChange={(v: ShopOrderStatus) => updateOrder(order?.id, { status: v })}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(statusLabels).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Nº seguimiento"
                    defaultValue={order?.trackingNumber ?? ''}
                    className="max-w-xs"
                    onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                      if ((e?.target?.value ?? '') !== (order?.trackingNumber ?? '')) {
                        updateOrder(order?.id, { trackingNumber: e?.target?.value ?? '' });
                      }
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
