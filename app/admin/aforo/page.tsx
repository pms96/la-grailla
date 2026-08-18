'use client';

import { useEffect, useState } from 'react';
import type { Event } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, Users, AlertTriangle } from 'lucide-react';
import { PageHeader } from '@/components/layouts/page-header';
import CapacityAlertsEditor from '@/components/admin/capacity-alerts-editor';

type EventWithCount = Event & { _count?: { tickets: number } };

export default function AforoPage() {
  const [events, setEvents] = useState<EventWithCount[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = () => {
    fetch('/api/admin/events')
      .then((r) => r.json())
      .then((d: EventWithCount[]) => setEvents((d ?? []).filter((e) => e?.status === 'PUBLISHED')))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); const i = setInterval(fetchData, 10000); return () => clearInterval(i); }, []);

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader title="Aforo en Tiempo Real" description="Control de capacidad de eventos activos" />
        <Button variant="outline" onClick={fetchData} className="gap-2"><RefreshCw className="h-4 w-4" /> Actualizar</Button>
      </div>

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
                  <div className="w-full bg-muted rounded-full h-4">
                    <div
                      className={`h-4 rounded-full transition-all ${isCritical ? 'bg-red-500' : isWarning ? 'bg-yellow-500' : 'bg-green-500'}`}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
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
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
