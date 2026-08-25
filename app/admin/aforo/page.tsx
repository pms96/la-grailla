'use client';

import { useEffect, useState } from 'react';
import type { Event, TicketType } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, Users, AlertTriangle, TrendingUp, Moon } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layouts/page-header';
import CapacityAlertsEditor from '@/components/admin/capacity-alerts-editor';
import { CapacityBar } from '@/components/admin/capacity-bar';

type EventWithCount = Event & {
  _count?: { tickets: number };
  ticketTypes?: Pick<TicketType, 'id' | 'name' | 'phaseName' | 'soldCount' | 'maxQuantity'>[];
  entryRate5min?: number;
  rejectionRate5min?: number | null;
  topScanners?: { name: string; count: number }[];
};

export default function AforoPage() {
  const [events, setEvents] = useState<EventWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [lastFetchFailed, setLastFetchFailed] = useState(false);
  const [, setTick] = useState(0);

  const fetchData = () => {
    fetch('/api/admin/events')
      .then((r) => r.json())
      .then((d: EventWithCount[]) => {
        setEvents((d ?? []).filter((e) => e?.status === 'PUBLISHED'));
        setLastUpdatedAt(Date.now());
        setLastFetchFailed(false);
      })
      .catch(() => setLastFetchFailed(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); const i = setInterval(fetchData, 10000); return () => clearInterval(i); }, []);
  // Re-render periódico solo para que "Actualizado hace Ns" avance entre polls.
  useEffect(() => { const i = setInterval(() => setTick((t) => t + 1), 5000); return () => clearInterval(i); }, []);

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader title="Aforo en Tiempo Real" description="Control de capacidad de eventos activos" />
        <Button variant="outline" onClick={fetchData} className="gap-2"><RefreshCw className="h-4 w-4" /> Actualizar</Button>
      </div>

      {lastUpdatedAt && (
        <p className={`text-xs -mt-4 ${lastFetchFailed ? 'text-yellow-600' : 'text-muted-foreground'}`}>
          {lastFetchFailed
            ? `No se ha podido actualizar — viendo datos de hace ${Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000))}s`
            : `Actualizado hace ${Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000))}s`}
        </p>
      )}

      {(events?.length ?? 0) === 0 ? (
        <p className="text-center py-20 text-muted-foreground">No hay eventos publicados</p>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {events.map((ev) => {
            const pct = (ev?.maxCapacity ?? 0) > 0 ? Math.round(((ev?.currentCount ?? 0) / (ev?.maxCapacity ?? 1)) * 100) : 0;
            const isFull = pct >= 100;
            const isWarning = pct >= 80;
            const isCritical = pct >= 95;
            const sold = ev?._count?.tickets ?? 0;
            const pending = Math.max(0, sold - (ev?.currentCount ?? 0));
            return (
              <Card key={ev?.id} className={isCritical ? 'border-red-500/50' : isWarning ? 'border-yellow-500/50' : ''}>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-display font-bold text-lg">{ev?.name ?? ''}</h3>
                    {isFull && <Badge variant="destructive">LLENO</Badge>}
                    {isCritical && !isFull && (
                      <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> Casi lleno</Badge>
                    )}
                    {isWarning && !isCritical && (
                      <Badge variant="secondary" className="gap-1"><AlertTriangle className="h-3 w-3" /> +80%</Badge>
                    )}
                  </div>
                  <div className="flex items-end gap-4 mb-3">
                    <div className="flex items-center gap-2">
                      <Users className="h-6 w-6 text-primary" />
                      <span className="font-display text-4xl font-bold">{ev?.currentCount ?? 0}</span>
                    </div>
                    <span className="text-muted-foreground text-lg mb-1">/ {ev?.maxCapacity ?? 0} dentro</span>
                  </div>
                  <CapacityBar current={ev?.currentCount ?? 0} max={ev?.maxCapacity ?? 0} sold={sold} size="lg" />
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-sm text-muted-foreground">{pct}% del aforo</p>
                    <CapacityAlertsEditor event={ev} onSaved={fetchData} />
                  </div>
                  <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border text-sm">
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">{sold}</span> vendidas
                    </span>
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">{pending}</span> por entrar
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <TrendingUp className="h-3.5 w-3.5" /> +{ev?.entryRate5min ?? 0} en 5 min
                    </span>
                    {(ev?.rejectionRate5min ?? 0) > 20 && (
                      <span className="flex items-center gap-1 text-yellow-500">
                        <AlertTriangle className="h-3.5 w-3.5" /> {ev.rejectionRate5min}% rechazados
                      </span>
                    )}
                  </div>
                  {(ev?.ticketTypes?.length ?? 0) > 0 && (
                    <div className="mt-3 pt-3 border-t border-border space-y-2">
                      {(ev?.ticketTypes ?? []).map((tt) => {
                        const ttPct = (tt?.maxQuantity ?? 0) > 0 ? Math.round(((tt?.soldCount ?? 0) / (tt?.maxQuantity ?? 1)) * 100) : 0;
                        return (
                          <div key={tt?.id}>
                            <div className="flex justify-between text-xs mb-0.5">
                              <span className="text-muted-foreground truncate">{tt?.name ?? ''}{tt?.phaseName ? ` · ${tt.phaseName}` : ''}</span>
                              <span className="text-muted-foreground shrink-0">{tt?.soldCount ?? 0}/{tt?.maxQuantity ?? 0}</span>
                            </div>
                            <div className="w-full bg-muted rounded-full h-1.5">
                              <div className="h-1.5 rounded-full bg-primary/60" style={{ width: `${Math.min(ttPct, 100)}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {(ev?.topScanners?.length ?? 0) > 0 && (
                    <div className="mt-3 pt-3 border-t border-border">
                      <p className="text-xs text-muted-foreground mb-1.5">Más escaneos validados</p>
                      <div className="flex flex-wrap gap-1.5">
                        {(ev?.topScanners ?? []).map((s, i) => (
                          <Badge key={`${s.name}-${i}`} variant="outline" className="text-xs">{s.name}: {s.count}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  <Button asChild variant="outline" size="sm" className="w-full mt-4 gap-2">
                    <Link href={`/admin/noche?eventId=${encodeURIComponent(ev?.id ?? '')}`}>
                      <Moon className="h-4 w-4" /> Modo noche
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
