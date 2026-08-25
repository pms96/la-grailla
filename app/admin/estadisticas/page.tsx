'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Event } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, BarChart3, DollarSign, Ticket, Calendar, Wallet, Download } from 'lucide-react';
import { PageHeader } from '@/components/layouts/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import CapacityAlertsEditor from '@/components/admin/capacity-alerts-editor';
import { CapacityBar } from '@/components/admin/capacity-bar';
import { downloadAdminCsv } from '@/lib/admin-export';
import SalesChart from './_components/sales-chart';

type StatsEvent = Pick<Event, 'id' | 'name' | 'maxCapacity' | 'currentCount' | 'alertThresholds' | 'alertsSent'> & { soldCount: number };

type Stats = {
  totalRevenue: number;
  netRevenue: number;
  totalTickets: number;
  totalOrders: number;
  totalEvents: number;
  events: StatsEvent[];
  byChannel: { channel: string; count: number; revenue: number }[];
  ticketTypeProgress: { id: string; name: string; phaseName: string | null; soldCount: number; maxQuantity: number }[];
  waitingRoomFunnel: { status: string; count: number }[];
  salesByDay: { date: string; revenue: number; count: number }[];
  recentOrders: {
    id: string;
    buyerName: string;
    buyerLastName: string;
    totalAmount: number;
    channel: string;
    createdAt: string;
    event: { name: string } | null;
  }[];
};

const CHANNEL_LABELS: Record<string, string> = {
  ONLINE: 'Online',
  TAQUILLA: 'Taquilla',
  INVITACION: 'Invitación',
};
const WAITING_ROOM_LABELS: Record<string, string> = {
  WAITING: 'En cola',
  ADMITTED: 'Admitidos',
  COMPLETED: 'Compraron',
  EXPIRED: 'Caducados',
};

const RANGE_OPTIONS = [
  { value: 'all', label: 'Todo' },
  { value: '7', label: 'Últimos 7 días' },
  { value: '30', label: 'Últimos 30 días' },
  { value: '1', label: 'Hoy' },
];

export default function EstadisticasPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [eventId, setEventId] = useState('all');
  const [range, setRange] = useState('all');
  const [exporting, setExporting] = useState<string | null>(null);

  const fetchStats = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (eventId !== 'all') params.set('eventId', eventId);
    if (range !== 'all') {
      const from = new Date();
      from.setDate(from.getDate() - (Number(range) - 1));
      from.setHours(0, 0, 0, 0);
      params.set('from', from.toISOString());
    }
    fetch(`/api/admin/stats?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => setStats(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [eventId, range]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const waitingRoomTotal = (stats?.waitingRoomFunnel ?? []).reduce((sum, w) => sum + (w?.count ?? 0), 0);

  const handleExport = async (type: 'orders' | 'tickets') => {
    if (type === 'tickets' && eventId === 'all') {
      toast.error('Selecciona un evento para exportar asistentes');
      return;
    }
    setExporting(type);
    try {
      await downloadAdminCsv({
        type,
        eventId: eventId === 'all' ? undefined : eventId,
      });
      toast.success('CSV descargado');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al exportar');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Estadísticas"
        description="Análisis de ventas, canales, aforo y sala de espera"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={eventId} onValueChange={setEventId}>
              <SelectTrigger className="w-[180px]"><SelectValue placeholder="Evento" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los eventos</SelectItem>
                {(stats?.events ?? []).map((ev) => (
                  <SelectItem key={ev?.id} value={ev?.id ?? ''}>{ev?.name ?? ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={exporting !== null}
              onClick={() => handleExport('orders')}
            >
              {exporting === 'orders' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Ventas CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={exporting !== null || eventId === 'all'}
              onClick={() => handleExport('tickets')}
              title={eventId === 'all' ? 'Selecciona un evento' : 'Exportar asistentes'}
            >
              {exporting === 'tickets' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Asistentes CSV
            </Button>
          </div>
        }
      />

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><DollarSign className="h-5 w-5 text-green-500" /><span className="text-xs text-muted-foreground">Ingresos brutos</span></div><p className="font-display text-2xl font-bold">{(stats?.totalRevenue ?? 0).toFixed(2)}€</p></CardContent></Card>
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><Wallet className="h-5 w-5 text-lima" /><span className="text-xs text-muted-foreground">Ingresos netos</span></div><p className="font-display text-2xl font-bold">{(stats?.netRevenue ?? 0).toFixed(2)}€</p></CardContent></Card>
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><Ticket className="h-5 w-5 text-primary" /><span className="text-xs text-muted-foreground">Entradas vendidas</span></div><p className="font-display text-2xl font-bold">{stats?.totalTickets ?? 0}</p></CardContent></Card>
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><BarChart3 className="h-5 w-5 text-blue-500" /><span className="text-xs text-muted-foreground">Pedidos</span></div><p className="font-display text-2xl font-bold">{stats?.totalOrders ?? 0}</p></CardContent></Card>
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><Calendar className="h-5 w-5 text-yellow-500" /><span className="text-xs text-muted-foreground">Eventos</span></div><p className="font-display text-2xl font-bold">{stats?.totalEvents ?? 0}</p></CardContent></Card>
          </div>

          <Card>
            <CardContent className="p-6">
              <h2 className="font-display font-bold text-lg mb-4">Ventas por día</h2>
              <SalesChart data={stats?.salesByDay ?? []} />
            </CardContent>
          </Card>

          <div className="grid md:grid-cols-2 gap-6">
            <Card>
              <CardContent className="p-6">
                <h2 className="font-display font-bold text-lg mb-4">Ventas por canal</h2>
                {(stats?.byChannel?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">Sin ventas en el periodo seleccionado.</p>
                ) : (
                  <div className="space-y-3">
                    {(stats?.byChannel ?? []).map((c) => (
                      <div key={c.channel} className="flex items-center justify-between text-sm">
                        <span className="font-medium">{CHANNEL_LABELS[c.channel] ?? c.channel}</span>
                        <span className="text-muted-foreground">{c.count} pedidos · {c.revenue.toFixed(2)}€</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {waitingRoomTotal > 0 && (
              <Card>
                <CardContent className="p-6">
                  <h2 className="font-display font-bold text-lg mb-4">Embudo de sala de espera</h2>
                  <div className="space-y-3">
                    {(stats?.waitingRoomFunnel ?? []).map((w) => (
                      <div key={w.status}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium">{WAITING_ROOM_LABELS[w.status] ?? w.status}</span>
                          <span className="text-muted-foreground">{w.count}</span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2">
                          <div className="h-2 rounded-full bg-primary/60" style={{ width: `${waitingRoomTotal > 0 ? Math.round((w.count / waitingRoomTotal) * 100) : 0}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {(stats?.ticketTypeProgress?.length ?? 0) > 0 && (
            <Card>
              <CardContent className="p-6">
                <h2 className="font-display font-bold text-lg mb-4">Progreso por tipo de entrada</h2>
                <div className="space-y-4">
                  {(stats?.ticketTypeProgress ?? []).map((tt) => {
                    const pct = tt.maxQuantity > 0 ? Math.round((tt.soldCount / tt.maxQuantity) * 100) : 0;
                    return (
                      <div key={tt.id}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium">{tt.name}{tt.phaseName ? ` · ${tt.phaseName}` : ''}</span>
                          <span className="text-muted-foreground">{tt.soldCount}/{tt.maxQuantity} ({pct}%)</span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2">
                          <div className={`h-2 rounded-full ${pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-primary'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {(stats?.recentOrders?.length ?? 0) > 0 && (
            <Card>
              <CardContent className="p-6">
                <h2 className="font-display font-bold text-lg mb-4">Últimas ventas</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b border-border">
                        <th className="pb-2 pr-4 font-medium">Evento</th>
                        <th className="pb-2 pr-4 font-medium">Comprador</th>
                        <th className="pb-2 pr-4 font-medium">Canal</th>
                        <th className="pb-2 pr-4 font-medium">Fecha</th>
                        <th className="pb-2 font-medium text-right">Importe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(stats?.recentOrders ?? []).map((o) => (
                        <tr key={o.id} className="border-b border-border/40 last:border-0">
                          <td className="py-2 pr-4 truncate max-w-[160px]">{o.event?.name ?? ''}</td>
                          <td className="py-2 pr-4 truncate max-w-[160px]">{o.buyerName} {o.buyerLastName}</td>
                          <td className="py-2 pr-4 text-muted-foreground">{CHANNEL_LABELS[o.channel] ?? o.channel}</td>
                          <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                            {new Date(o.createdAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="py-2 text-right font-medium">{o.totalAmount.toFixed(2)}€</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {(stats?.events?.length ?? 0) > 0 && (
            <Card>
              <CardContent className="p-6">
                <h2 className="font-display font-bold text-lg mb-1">Eventos por aforo</h2>
                <p className="text-sm text-muted-foreground mb-4">Configura umbrales de aviso por email en cada evento.</p>
                <div className="space-y-4">
                  {(stats?.events ?? []).map((ev) => {
                    const pct = (ev?.maxCapacity ?? 0) > 0 ? Math.round(((ev?.currentCount ?? 0) / (ev?.maxCapacity ?? 1)) * 100) : 0;
                    return (
                      <div key={ev?.id}>
                        <div className="flex justify-between items-center gap-3 text-sm mb-1">
                          <span className="font-medium truncate">{ev?.name ?? ''}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-muted-foreground">{ev?.currentCount ?? 0}/{ev?.maxCapacity ?? 0} dentro ({pct}%)</span>
                            <CapacityAlertsEditor event={ev} onSaved={fetchStats} />
                          </div>
                        </div>
                        <CapacityBar current={ev?.currentCount ?? 0} max={ev?.maxCapacity ?? 0} sold={ev?.soldCount ?? 0} size="md" />
                        <p className="text-xs text-muted-foreground mt-1">{ev?.soldCount ?? 0} entradas vendidas</p>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
