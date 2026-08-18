'use client';

import { useEffect, useState } from 'react';
import type { Event, Prisma } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, DollarSign, Ticket, Calendar, Users, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { FadeIn, Stagger, StaggerItem } from '@/components/ui/animate';

type DashboardEvent = Pick<Event, 'id' | 'name' | 'maxCapacity' | 'currentCount' | 'date' | 'status' | 'alertThresholds' | 'alertsSent'>;

type DashboardOrder = Prisma.OrderGetPayload<{ include: { event: { select: { name: true } } } }>;

type DashboardStats = {
  totalOrders: number;
  totalTickets: number;
  totalEvents: number;
  totalRevenue: number;
  recentOrders: DashboardOrder[];
  events: DashboardEvent[];
};

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
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

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  const cards = [
    { label: 'Ingresos', value: `${(stats?.totalRevenue ?? 0).toFixed(2)}€`, icon: DollarSign, color: 'text-green-500' },
    { label: 'Entradas Vendidas', value: stats?.totalTickets ?? 0, icon: Ticket, color: 'text-primary' },
    { label: 'Pedidos Completados', value: stats?.totalOrders ?? 0, icon: Users, color: 'text-blue-500' },
    { label: 'Eventos', value: stats?.totalEvents ?? 0, icon: Calendar, color: 'text-yellow-500' },
  ];

  return (
    <div className="space-y-6">
      <FadeIn>
        <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Vista general de La Grailla</p>
      </FadeIn>

      <Stagger staggerDelay={0.1}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {cards.map((c, i) => (
            <StaggerItem key={i}>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <c.icon className={`h-5 w-5 ${c.color}`} />
                    <span className="text-xs text-muted-foreground">{c.label}</span>
                  </div>
                  <p className="font-display text-2xl font-bold">{c.value}</p>
                </CardContent>
              </Card>
            </StaggerItem>
          ))}
        </div>
      </Stagger>

      {/* Capacity overview */}
      {(stats?.events?.length ?? 0) > 0 && (
        <FadeIn>
          <Card>
            <CardContent className="p-6">
              <h2 className="font-display font-bold text-lg mb-4">Aforo por Evento</h2>
              <div className="space-y-3">
                {(stats?.events ?? []).map((ev) => {
                  const pct = (ev?.maxCapacity ?? 0) > 0 ? Math.round(((ev?.currentCount ?? 0) / (ev?.maxCapacity ?? 1)) * 100) : 0;
                  return (
                    <div key={ev?.id} className="flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{ev?.name ?? ''}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 bg-muted rounded-full h-2">
                            <div
                              className={`h-2 rounded-full ${pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`}
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground w-20 text-right">{ev?.currentCount ?? 0}/{ev?.maxCapacity ?? 0}</span>
                        </div>
                      </div>
                      <Badge variant={ev?.status === 'PUBLISHED' ? 'default' : 'secondary'} className="text-xs">
                        {ev?.status === 'PUBLISHED' ? 'Activo' : 'Finalizado'}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </FadeIn>
      )}

      {/* Recent orders */}
      {(stats?.recentOrders?.length ?? 0) > 0 && (
        <FadeIn>
          <Card>
            <CardContent className="p-6">
              <h2 className="font-display font-bold text-lg mb-4">Últimas Ventas</h2>
              <div className="space-y-2">
                {(stats?.recentOrders ?? []).map((o) => (
                  <div key={o?.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                    <div>
                      <p className="text-sm font-medium">{o?.buyerName ?? ''} {o?.buyerLastName ?? ''}</p>
                      <p className="text-xs text-muted-foreground">{o?.event?.name ?? ''}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-primary">{(o?.totalAmount ?? 0).toFixed(2)}€</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={sending === o?.id}
                        onClick={() => resendTickets(o?.id)}
                        title="Reenviar entradas por email"
                      >
                        {sending === o?.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </FadeIn>
      )}
    </div>
  );
}
