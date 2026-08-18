'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Event } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, BarChart3, DollarSign, Ticket, Calendar } from 'lucide-react';
import { PageHeader } from '@/components/layouts/page-header';
import { FadeIn } from '@/components/ui/animate';
import CapacityAlertsEditor from '@/components/admin/capacity-alerts-editor';

type StatsEvent = Pick<Event, 'id' | 'name' | 'maxCapacity' | 'currentCount' | 'alertThresholds' | 'alertsSent'>;

type Stats = {
  totalRevenue: number;
  totalTickets: number;
  totalOrders: number;
  totalEvents: number;
  events: StatsEvent[];
};

export default function EstadisticasPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(() => {
    fetch('/api/admin/stats')
      .then((r) => r.json())
      .then((d) => setStats(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Estadísticas" description="Resumen global de ventas y actividad" />

      <FadeIn>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><DollarSign className="h-5 w-5 text-green-500" /><span className="text-xs text-muted-foreground">Ingresos Totales</span></div><p className="font-display text-2xl font-bold">{(stats?.totalRevenue ?? 0).toFixed(2)}€</p></CardContent></Card>
          <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><Ticket className="h-5 w-5 text-primary" /><span className="text-xs text-muted-foreground">Entradas</span></div><p className="font-display text-2xl font-bold">{stats?.totalTickets ?? 0}</p></CardContent></Card>
          <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><BarChart3 className="h-5 w-5 text-blue-500" /><span className="text-xs text-muted-foreground">Pedidos</span></div><p className="font-display text-2xl font-bold">{stats?.totalOrders ?? 0}</p></CardContent></Card>
          <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><Calendar className="h-5 w-5 text-yellow-500" /><span className="text-xs text-muted-foreground">Eventos</span></div><p className="font-display text-2xl font-bold">{stats?.totalEvents ?? 0}</p></CardContent></Card>
        </div>
      </FadeIn>

      {(stats?.events?.length ?? 0) > 0 && (
        <FadeIn>
          <Card>
            <CardContent className="p-6">
              <h2 className="font-display font-bold text-lg mb-1">Eventos por Aforo</h2>
              <p className="text-sm text-muted-foreground mb-4">Configura en cada evento a partir de qué porcentaje quieres recibir un aviso por email.</p>
              <div className="space-y-4">
                {(stats?.events ?? []).map((ev) => {
                  const pct = (ev?.maxCapacity ?? 0) > 0 ? Math.round(((ev?.currentCount ?? 0) / (ev?.maxCapacity ?? 1)) * 100) : 0;
                  return (
                    <div key={ev?.id}>
                      <div className="flex justify-between items-center gap-3 text-sm mb-1">
                        <span className="font-medium truncate">{ev?.name ?? ''}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-muted-foreground">{ev?.currentCount ?? 0}/{ev?.maxCapacity ?? 0} ({pct}%)</span>
                          <CapacityAlertsEditor event={ev} onSaved={fetchStats} />
                        </div>
                      </div>
                      <div className="w-full bg-muted rounded-full h-3">
                        <div className={`h-3 rounded-full ${pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </FadeIn>
      )}
    </div>
  );
}
