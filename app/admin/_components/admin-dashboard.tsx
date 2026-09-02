'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Event, Prisma } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, DollarSign, Ticket, Calendar, Receipt, Mail, Moon, ArrowRight, BarChart3, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { CapacityBar } from '@/components/admin/capacity-bar';
import { isEventTonight } from '@/lib/active-event';

type DashboardEvent = Pick<Event, 'id' | 'name' | 'maxCapacity' | 'currentCount' | 'date' | 'status'> & {
  soldCount: number;
};

type DashboardOrder = Prisma.OrderGetPayload<{ include: { event: { select: { name: true } } } }>;

type DashboardStats = {
  totalOrders: number;
  totalTickets: number;
  totalEvents: number;
  totalRevenue: number;
  recentOrders: DashboardOrder[];
  events: DashboardEvent[];
};

type MargenTemporada = { nombre: string; margen: number; nEventosEnlazados: number };

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [margenTemporada, setMargenTemporada] = useState<MargenTemporada | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);

  const resendTickets = async (orderId: string) => {
    setSending(orderId);
    try {
      const res = await fetch(`/api/orders/${orderId}/send-tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error ?? 'Error');
      toast.success('Entradas reenviadas por email');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudieron reenviar las entradas');
    } finally {
      setSending(null);
    }
  };

  useEffect(() => {
    fetch('/api/admin/stats')
      .then((r) => r.json())
      .then((data) => setStats(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch('/api/admin/compras/temporadas')
      .then((r) => r.json())
      .then((temporadas: { id: string; nombre: string; status: string }[]) => {
        const activa = (Array.isArray(temporadas) ? temporadas : []).find((t) => t.status === 'ABIERTA');
        if (!activa) return;
        return fetch(`/api/admin/gastos/resumen?temporadaId=${activa.id}`)
          .then((r) => r.json())
          .then((resumen) => setMargenTemporada({ nombre: activa.nombre, margen: resumen?.margen ?? 0, nEventosEnlazados: resumen?.nEventosEnlazados ?? 0 }));
      })
      .catch(() => {});
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const cards = [
    { label: 'Ingresos', value: `${(stats?.totalRevenue ?? 0).toFixed(2)}€`, icon: DollarSign, color: 'text-green-500' },
    { label: 'Entradas vendidas', value: stats?.totalTickets ?? 0, icon: Ticket, color: 'text-primary' },
    { label: 'Pedidos', value: stats?.totalOrders ?? 0, icon: Receipt, color: 'text-blue-500' },
    { label: 'Eventos', value: stats?.totalEvents ?? 0, icon: Calendar, color: 'text-yellow-500' },
  ];

  const tonightEvent = (stats?.events ?? []).find(
    (ev) => ev?.status === 'PUBLISHED' && isEventTonight(ev?.date)
  );
  const activeEvents = (stats?.events ?? []).filter((ev) => ev?.status === 'PUBLISHED').slice(0, 4);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Resumen operativo de La Grailla</p>
        </div>
        <Button variant="outline" size="sm" className="gap-2 shrink-0" asChild>
          <Link href="/admin/estadisticas">
            <BarChart3 className="h-4 w-4" /> Ver estadísticas
          </Link>
        </Button>
      </div>

      {tonightEvent && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <Moon className="h-6 w-6 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Evento en marcha</p>
                <p className="text-sm text-muted-foreground truncate">{tonightEvent.name}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {tonightEvent.currentCount ?? 0}/{tonightEvent.maxCapacity ?? 0} dentro · {tonightEvent.soldCount ?? 0} vendidas
                </p>
              </div>
            </div>
            <Button asChild className="gap-2 shrink-0">
              <Link href={`/admin/noche?eventId=${encodeURIComponent(tonightEvent.id)}`}>
                Abrir modo noche <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className={`grid grid-cols-2 gap-4 ${margenTemporada && margenTemporada.nEventosEnlazados > 0 ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <c.icon className={`h-5 w-5 ${c.color}`} />
                <span className="text-xs text-muted-foreground">{c.label}</span>
              </div>
              <p className="font-display text-2xl font-bold">{c.value}</p>
            </CardContent>
          </Card>
        ))}
        {margenTemporada && margenTemporada.nEventosEnlazados > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Wallet className={`h-5 w-5 ${margenTemporada.margen >= 0 ? 'text-green-500' : 'text-destructive'}`} />
                <span className="text-xs text-muted-foreground">Margen ({margenTemporada.nombre})</span>
              </div>
              <p className="font-display text-2xl font-bold">
                {margenTemporada.margen >= 0 ? '+' : ''}{margenTemporada.margen.toFixed(2)}€
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {activeEvents.length > 0 && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="font-display font-bold text-lg">Aforo activo</h2>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/admin/aforo">Detalle</Link>
              </Button>
            </div>
            <div className="space-y-3">
              {activeEvents.map((ev) => (
                <div key={ev.id} className="flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{ev.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <CapacityBar
                        current={ev.currentCount ?? 0}
                        max={ev.maxCapacity ?? 0}
                        sold={ev.soldCount ?? 0}
                        className="flex-1"
                      />
                      <span className="text-xs text-muted-foreground w-24 text-right">
                        {ev.currentCount ?? 0}/{ev.maxCapacity ?? 0}
                      </span>
                    </div>
                  </div>
                  <Badge variant="default" className="text-xs shrink-0">Activo</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {(stats?.recentOrders?.length ?? 0) > 0 && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="font-display font-bold text-lg">Últimas ventas</h2>
              <Button variant="outline" size="sm" asChild>
                <Link href="/admin/ventas">Ver todas</Link>
              </Button>
            </div>
            <div className="space-y-2">
              {(stats?.recentOrders ?? []).slice(0, 5).map((o) => (
                <div key={o.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <Link href={`/admin/ventas?id=${o.id}`} className="min-w-0 hover:underline">
                    <p className="text-sm font-medium">
                      {o.buyerName} {o.buyerLastName}
                    </p>
                    <p className="text-xs text-muted-foreground">{o.event?.name ?? ''}</p>
                  </Link>
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-primary">{o.totalAmount.toFixed(2)}€</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={sending === o.id}
                      onClick={() => resendTickets(o.id)}
                      title="Reenviar entradas"
                    >
                      {sending === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
