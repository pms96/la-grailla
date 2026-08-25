'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrderStatus, Prisma } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Loader2, Mail, Search, Ticket, X, Ban, RotateCcw, ExternalLink, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';
import { downloadAdminCsv } from '@/lib/admin-export';

const statusLabels: Record<OrderStatus, string> = {
  PENDING: 'Pendiente',
  COMPLETED: 'Completado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Reembolsado',
};

const statusVariant: Record<OrderStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'outline',
  COMPLETED: 'default',
  CANCELLED: 'secondary',
  REFUNDED: 'destructive',
};

const channelLabels: Record<string, string> = {
  ONLINE: 'Online',
  TAQUILLA: 'Taquilla',
  INVITATION: 'Invitación',
  INVITACION: 'Invitación',
};

type OrderListItem = Prisma.OrderGetPayload<{
  include: {
    event: { select: { id: true; name: true; date: true } };
    tickets: { select: { id: true; status: true } };
    _count: { select: { tickets: true } };
  };
}>;

type OrderDetail = Prisma.OrderGetPayload<{
  include: {
    event: { select: { id: true; name: true; date: true; venue: true; city: true } };
    tickets: {
      include: { ticketType: { select: { id: true; name: true; price: true } } };
    };
    invitation: { select: { id: true; guestName: true; listId: true } };
  };
}>;

export default function VentasPage() {
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [emailFailedOnly, setEmailFailedOnly] = useState(false);
  const [eventFilter, setEventFilter] = useState<string>('all');
  const [events, setEvents] = useState<{ id: string; name: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const fetchOrders = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (status !== 'all' && !emailFailedOnly) params.set('status', status);
    if (emailFailedOnly) params.set('emailFailed', '1');
    if (eventFilter !== 'all') params.set('eventId', eventFilter);
    fetch(`/api/admin/orders?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => setOrders(Array.isArray(d) ? d : []))
      .catch(() => toast.error('No se pudieron cargar las ventas'))
      .finally(() => setLoading(false));
  }, [q, status, eventFilter, emailFailedOnly]);

  useEffect(() => {
    fetch('/api/admin/events')
      .then((r) => r.json())
      .then((list) => setEvents((list ?? []).map((e: { id: string; name: string }) => ({ id: e.id, name: e.name }))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get('eventId');
    if (eventId) setEventFilter(eventId);
  }, []);

  useEffect(() => {
    const t = setTimeout(fetchOrders, 250);
    return () => clearTimeout(t);
  }, [fetchOrders]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/orders/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Error');
      setDetail(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar el detalle');
      setSelectedId(null);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) void openDetail(id);
  }, [openDetail]);

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
  };

  const resendTickets = async (orderId: string) => {
    setActionLoading('resend');
    try {
      const res = await fetch(`/api/orders/${orderId}/send-tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error ?? 'Error al reenviar');
      toast.success('Entradas reenviadas por email');
      if (selectedId === orderId) await openDetail(orderId);
      fetchOrders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudieron reenviar');
    } finally {
      setActionLoading(null);
    }
  };

  const runAction = async (orderId: string, action: 'cancel' | 'refund') => {
    const label = action === 'refund' ? 'reembolsar' : 'cancelar';
    if (!confirm(`¿Seguro que quieres ${label} este pedido? Se anularán las entradas y se liberará el aforo.`)) {
      return;
    }
    setActionLoading(action);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Error');
      setDetail(data);
      toast.success(action === 'refund' ? 'Pedido reembolsado' : 'Pedido cancelado');
      fetchOrders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo completar la acción');
    } finally {
      setActionLoading(null);
    }
  };

  const canInvalidate = detail?.status === 'COMPLETED' || detail?.status === 'PENDING';
  const canRefund = detail?.status === 'COMPLETED';

  const handleExport = async () => {
    setExporting(true);
    try {
      await downloadAdminCsv({
        type: 'orders',
        eventId: eventFilter === 'all' ? undefined : eventFilter,
      });
      toast.success('CSV de ventas descargado');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al exportar');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ventas de entradas"
        description="Pedidos online, taquilla e invitaciones. Busca, reenvía PDF o anula."
        actions={
          <Button variant="outline" size="sm" className="gap-2" disabled={exporting} onClick={handleExport}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Exportar CSV
          </Button>
        }
      />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Email, nombre, ID o payment ID…"
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
        <Select value={eventFilter} onValueChange={setEventFilter}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="Evento" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los eventos</SelectItem>
            {events.map((ev) => (
              <SelectItem key={ev.id} value={ev.id}>{ev.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={emailFailedOnly ? 'default' : 'outline'}
          size="sm"
          className="gap-2 shrink-0"
          onClick={() => setEmailFailedOnly((v) => !v)}
        >
          <Mail className="h-4 w-4" />
          Sin email
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-3 min-w-0">
          {loading ? (
            <div className="flex justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : orders.length === 0 ? (
            <p className="text-center py-20 text-muted-foreground">No hay ventas con estos filtros</p>
          ) : (
            orders.map((order) => {
              const active = selectedId === order.id;
              return (
                <Card
                  key={order.id}
                  className={active ? 'ring-2 ring-primary/40' : 'cursor-pointer hover:bg-muted/30 transition-colors'}
                  onClick={() => openDetail(order.id)}
                >
                  <CardContent className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">
                        {order.buyerName} {order.buyerLastName}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {order.buyerEmail} · {order.event?.name ?? '—'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(order.createdAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}
                        {' · '}
                        {channelLabels[order.channel] ?? order.channel}
                        {' · '}
                        {order._count?.tickets ?? order.tickets?.length ?? 0} entradas
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant={statusVariant[order.status]}>{statusLabels[order.status]}</Badge>
                      {order.status === 'COMPLETED' && !order.emailSentAt && (
                        <Badge variant="destructive" className="text-xs">Sin email</Badge>
                      )}
                      <span className="font-bold text-primary">{order.totalAmount.toFixed(2)}€</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          {!selectedId ? (
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                <Ticket className="h-8 w-8 mx-auto mb-3 opacity-40" />
                Selecciona una venta para ver el detalle
              </CardContent>
            </Card>
          ) : detailLoading || !detail ? (
            <Card>
              <CardContent className="flex justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {detail.buyerName} {detail.buyerLastName}
                    </p>
                    <p className="text-xs text-muted-foreground break-all">{detail.buyerEmail}</p>
                    <p className="text-xs text-muted-foreground font-mono mt-1">
                      {detail.id.slice(0, 12).toUpperCase()}…
                    </p>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={closeDetail} aria-label="Cerrar">
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={statusVariant[detail.status]}>{statusLabels[detail.status]}</Badge>
                  <Badge variant="outline">{channelLabels[detail.channel] ?? detail.channel}</Badge>
                  <span className="text-sm font-bold text-primary ml-auto">
                    {detail.totalAmount.toFixed(2)}€
                  </span>
                </div>

                <div className="text-sm space-y-1 rounded-md bg-muted/50 p-3">
                  <p><span className="text-muted-foreground">Evento:</span> {detail.event?.name ?? '—'}</p>
                  <p>
                    <span className="text-muted-foreground">Fecha:</span>{' '}
                    {detail.event?.date
                      ? new Date(detail.event.date).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })
                      : '—'}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Pago:</span>{' '}
                    {detail.paymentMethod}
                    {detail.paymentProvider ? ` · ${detail.paymentProvider}` : ''}
                  </p>
                  {detail.emailSentAt && (
                    <p>
                      <span className="text-muted-foreground">Email:</span>{' '}
                      {new Date(detail.emailSentAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}
                    </p>
                  )}
                  {detail.status === 'COMPLETED' && !detail.emailSentAt && (
                    <p className="text-destructive">
                      <span className="text-muted-foreground">Email:</span> no enviado
                      {detail.emailLastError ? ` — ${detail.emailLastError}` : ''}
                      {detail.emailAttempts > 0 ? ` (${detail.emailAttempts} intento${detail.emailAttempts === 1 ? '' : 's'})` : ''}
                    </p>
                  )}
                  {detail.invitation && (
                    <p>
                      <span className="text-muted-foreground">Invitación:</span>{' '}
                      {detail.invitation.guestName ?? detail.invitation.id.slice(0, 8)}
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Entradas ({detail.tickets?.length ?? 0})
                  </p>
                  <ul className="space-y-2 max-h-48 overflow-y-auto">
                    {(detail.tickets ?? []).map((t) => (
                      <li key={t.id} className="text-sm flex justify-between gap-2 border-b border-border/50 pb-1.5">
                        <span className="truncate">
                          {t.holderName}
                          <span className="text-muted-foreground"> · {t.ticketType?.name ?? 'General'}</span>
                        </span>
                        <Badge variant="outline" className="text-xs shrink-0">{t.status}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex flex-col gap-2 pt-1">
                  {detail.status === 'COMPLETED' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={actionLoading !== null}
                      onClick={() => resendTickets(detail.id)}
                    >
                      {actionLoading === 'resend'
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Mail className="h-4 w-4" />}
                      Reenviar entradas
                    </Button>
                  )}
                  {detail.status === 'COMPLETED' && (
                    <Button variant="outline" size="sm" className="gap-2" asChild>
                      <Link href={`/confirmacion/${detail.id}`} target="_blank">
                        <ExternalLink className="h-4 w-4" /> Ver confirmación
                      </Link>
                    </Button>
                  )}
                  {canInvalidate && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2 text-destructive"
                      disabled={actionLoading !== null}
                      onClick={() => runAction(detail.id, 'cancel')}
                    >
                      {actionLoading === 'cancel'
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Ban className="h-4 w-4" />}
                      Cancelar pedido
                    </Button>
                  )}
                  {canRefund && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2 text-destructive"
                      disabled={actionLoading !== null}
                      onClick={() => runAction(detail.id, 'refund')}
                    >
                      {actionLoading === 'refund'
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <RotateCcw className="h-4 w-4" />}
                      Reembolsar
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
