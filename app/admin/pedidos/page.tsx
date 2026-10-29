'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Prisma, ShopOrderStatus, Temporada } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Loader2, Package, Truck, Search, Phone, Download, StickyNote, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';
import { downloadShopOrdersCsv } from '@/lib/admin-export';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';

const statusLabels: Record<string, string> = {
  PENDING: 'Pendiente', PAID: 'Pagado', PROCESSING: 'Procesando',
  SHIPPED: 'Enviado', DELIVERED: 'Entregado', CANCELLED: 'Cancelado', REFUNDED: 'Reembolsado',
};

/** Estado real del email de confirmación (lo calcula la API a partir de los marcadores de envío: lib/email-delivery.ts). La tienda no guarda el texto del error. */
type EmailDelivery = {
  status: 'sent' | 'sending' | 'pending' | 'retrying' | 'exhausted' | 'unknown';
  attempts: number;
  sentAt: string | null;
  nextAttemptAt: string | null;
} | null;

type ShopOrderWithItems = Prisma.ShopOrderGetPayload<{ include: { items: { include: { product: true } } } }> & { emailDelivery?: EmailDelivery };

const PAID_STATUSES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

function emailLine(d: NonNullable<EmailDelivery>): string {
  const tries = d.attempts > 0 ? ` (${d.attempts} intento${d.attempts === 1 ? '' : 's'})` : '';
  const at = (iso: string) => new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  switch (d.status) {
    case 'sent':
      return `enviado${d.sentAt ? ` el ${at(d.sentAt)}` : ''}`;
    case 'sending':
      return `enviándose ahora${tries}`;
    case 'pending':
      return 'pendiente del primer envío';
    case 'retrying':
      return `no enviado${tries}; se reintenta solo${d.nextAttemptAt ? ` a partir de las ${new Date(d.nextAttemptAt).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })}` : ''}`;
    case 'exhausted':
      return `FALLIDO${tries}: no se reintentará solo; revisa el SMTP y reenvíalo`;
    default:
      return 'sin registro (pedido anterior al seguimiento de emails)';
  }
}

export default function PedidosPage() {
  const [orders, setOrders] = useState<ShopOrderWithItems[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [exporting, setExporting] = useState(false);
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  // Las temporadas son de Contabilidad: sin ese módulo la API responde 404 y el selector no se muestra.
  const [temporadasDisponibles, setTemporadasDisponibles] = useState(false);

  useEffect(() => {
    fetch('/api/admin/compras/temporadas')
      .then((r) => {
        setTemporadasDisponibles(r.ok);
        return r.json();
      })
      .then((d) => setTemporadas(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

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

  const updateOrder = async (id: string, data: Partial<Pick<ShopOrderWithItems, 'status' | 'trackingNumber' | 'temporadaId'>> & { resendShippedEmail?: boolean }) => {
    if (
      (data.status === 'CANCELLED' || data.status === 'REFUNDED') &&
      !confirm(`¿Marcar este pedido como ${statusLabels[data.status]?.toLowerCase()}?`)
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/admin/shop-orders/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? 'Error');
      // Al pasar a «Enviado» (o llegar el seguimiento) el servidor avisa al comprador por email: se dice qué pasó, sin callar un fallo.
      if (body?.shippedEmail === 'sent') toast.success('Actualizado y aviso de envío enviado al comprador');
      else if (body?.shippedEmail === 'failed') toast.error('Actualizado, pero no se pudo enviar el aviso de envío: revisa el correo y pulsa «Reenviar aviso de envío»');
      else if (body?.shippedEmail === 'no_recipient') toast.warning('Actualizado, pero el email del comprador no es válido: no se envió el aviso de envío');
      else toast.success('Actualizado');
      fetchOrders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error');
    }
  };

  // Punto único de envío (concesión atómica, rastro del intento); solo ADMIN y queda en el log de auditoría.
  const [resending, setResending] = useState<string | null>(null);
  const resendEmail = async (id: string) => {
    setResending(id);
    try {
      const res = await fetch(`/api/admin/shop-orders/${id}/resend-email`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.status === 'sending' ? 'Ya se está enviando: espera un momento' : (data?.error ?? 'Error al reenviar'));
      }
      toast.success('Email reenviado');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo reenviar');
    } finally {
      setResending(null);
      fetchOrders();
    }
  };

  // Mismos filtros que el listado en pantalla (búsqueda y estado).
  const handleExport = async () => {
    setExporting(true);
    try {
      await downloadShopOrdersCsv({ q: q.trim() || undefined, status: status !== 'all' ? status : undefined });
      toast.success('CSV de pedidos descargado');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al exportar');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <PageHeader title="Pedidos de Tienda" description="Gestiona los pedidos de merchandising" />
        <Button variant="outline" size="sm" className="gap-2 shrink-0" disabled={exporting} onClick={handleExport}>
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Exportar CSV
        </Button>
      </div>

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
                <div className="text-sm text-muted-foreground space-y-1">
                  <ul className="space-y-0.5">
                    {(order?.items ?? []).map((i) => {
                      const variant = [i?.size, i?.color].filter(Boolean).join(' · ');
                      return (
                        <li key={i?.id} className="flex items-start justify-between gap-3">
                          <span className="min-w-0 break-words">
                            <Package className="h-3 w-3 inline mr-1" />
                            <span className="text-foreground">{i?.product?.name ?? ''}</span>
                            {variant && <span> · {variant}</span>} × {i?.quantity ?? 0}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {(Number(i?.unitPrice ?? 0) * (i?.quantity ?? 0)).toFixed(2)}€
                            {(i?.quantity ?? 0) > 1 && <span className="text-xs"> ({Number(i?.unitPrice ?? 0).toFixed(2)}€/u.)</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="break-words">
                    <Truck className="h-3 w-3 inline mr-1" /> {order?.shippingAddress ?? ''}, {order?.shippingZip ?? ''} {order?.shippingCity ?? ''}
                  </p>
                  {order?.shippingPhone && (
                    <p>
                      <Phone className="h-3 w-3 inline mr-1" />
                      <a href={`tel:${order.shippingPhone.replace(/[^\d+]/g, '')}`} className="underline underline-offset-2">{order.shippingPhone}</a>
                    </p>
                  )}
                  {order?.notes && (
                    <p className="break-words"><StickyNote className="h-3 w-3 inline mr-1" /> {order.notes}</p>
                  )}
                  {order?.status === 'SHIPPED' && (
                    <p>
                      <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={() => updateOrder(order.id, { resendShippedEmail: true })}>
                        <Mail className="h-3 w-3" /> Reenviar aviso de envío
                      </Button>
                    </p>
                  )}
                  {PAID_STATUSES.includes(order?.status ?? '') && order?.emailDelivery && (
                    <p className={`flex flex-wrap items-center gap-2 ${order.emailDelivery.status === 'exhausted' ? 'text-destructive' : ''}`}>
                      <span><Mail className="h-3 w-3 inline mr-1" /> Email: {emailLine(order.emailDelivery)}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 gap-1 px-2 text-xs"
                        disabled={resending === order.id}
                        onClick={() => resendEmail(order.id)}
                      >
                        {resending === order.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}
                        Reenviar email
                      </Button>
                    </p>
                  )}
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
                  {temporadasDisponibles && (
                    <TemporadaSelector
                      temporadas={temporadas}
                      temporadaId={order?.temporadaId ?? null}
                      onChange={(id) => updateOrder(order?.id, { temporadaId: id })}
                      onTemporadaCreada={(t) => setTemporadas((prev) => [t, ...prev])}
                      allowNone
                    />
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
