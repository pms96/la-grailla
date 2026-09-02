'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Prisma, ShopOrderStatus } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Loader2, Package, Truck, Search } from 'lucide-react';
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
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('all');

  const fetchOrders = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (status !== 'all') params.set('status', status);
    fetch(`/api/admin/shop-orders?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => setOrders(d ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [q, status]);

  useEffect(() => {
    const t = setTimeout(fetchOrders, 250);
    return () => clearTimeout(t);
  }, [fetchOrders]);

  const updateOrder = async (id: string, data: Partial<Pick<ShopOrderWithItems, 'status' | 'trackingNumber'>>) => {
    if (
      (data.status === 'CANCELLED' || data.status === 'REFUNDED') &&
      !confirm(`¿Marcar este pedido como ${statusLabels[data.status]?.toLowerCase()}?`)
    ) {
      return;
    }
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

  return (
    <div className="space-y-6">
      <PageHeader title="Pedidos de Tienda" description="Gestiona los pedidos de merchandising" />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Nombre o email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {Object.entries(statusLabels).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      ) : (orders?.length ?? 0) === 0 ? (
        <p className="text-center py-20 text-muted-foreground">
          {q.trim() || status !== 'all' ? 'Sin pedidos con este filtro' : 'No hay pedidos aún'}
        </p>
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
