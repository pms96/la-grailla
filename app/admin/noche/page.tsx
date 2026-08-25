'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Event } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Loader2, RefreshCw, Users, QrCode, Ticket, ShoppingCart, UserPlus,
  AlertTriangle, TrendingUp, ArrowRight, ScanLine,
} from 'lucide-react';
import { PageHeader } from '@/components/layouts/page-header';
import { CapacityBar } from '@/components/admin/capacity-bar';
import {
  getStoredActiveEventId,
  pickDefaultActiveEventId,
  setStoredActiveEventId,
} from '@/lib/active-event';

type NochePayload = {
  event: Pick<Event, 'id' | 'name' | 'date' | 'doorsOpen' | 'venue' | 'city' | 'status' | 'maxCapacity' | 'currentCount'>;
  capacity: {
    current: number;
    max: number;
    sold: number;
    pending: number;
    percent: number;
    entryRate5min: number;
    rejectionRate5min: number | null;
  };
  ticketTypes: { id: string; name: string; phaseName: string | null; soldCount: number; maxQuantity: number }[];
  topScanners: { name: string; count: number }[];
  recentOrders: {
    id: string;
    buyerName: string;
    buyerLastName: string;
    totalAmount: number;
    channel: string;
    createdAt: string;
    _count: { tickets: number };
  }[];
  recentScans: {
    id: string;
    result: string;
    createdAt: string;
    holderName: string;
    ticketType: string | null;
    scannerName: string | null;
  }[];
};

const channelLabels: Record<string, string> = {
  ONLINE: 'Online',
  TAQUILLA: 'Taquilla',
  INVITATION: 'Invitación',
};

const scanResultLabel: Record<string, string> = {
  VALID: 'Válido',
  DUPLICATE: 'Duplicado',
  INVALID: 'Inválido',
  CANCELLED: 'Anulado',
  WRONG_EVENT: 'Otro evento',
  ERROR: 'Error',
};

function accesoHref(eventId: string, tab: 'scan' | 'taquilla' | 'invitaciones') {
  return `/acceso?eventId=${encodeURIComponent(eventId)}&tab=${tab}`;
}

export default function NochePage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventId, setEventId] = useState('');
  const [data, setData] = useState<NochePayload | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [loadingData, setLoadingData] = useState(false);

  useEffect(() => {
    fetch('/api/admin/events')
      .then((r) => r.json())
      .then((list: Event[]) => {
        const published = (list ?? []).filter((e) => e.status === 'PUBLISHED');
        setEvents(published);
        const fromUrl = new URLSearchParams(window.location.search).get('eventId');
        const stored = getStoredActiveEventId();
        const initial =
          (fromUrl && published.some((e) => e.id === fromUrl) ? fromUrl : null) ??
          (stored && published.some((e) => e.id === stored) ? stored : null) ??
          pickDefaultActiveEventId(published);
        if (initial) setEventId(initial);
      })
      .catch(() => {})
      .finally(() => setLoadingEvents(false));
  }, []);

  const fetchNoche = useCallback(() => {
    if (!eventId) return;
    setLoadingData(true);
    fetch(`/api/admin/noche?eventId=${encodeURIComponent(eventId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d?.error) setData(d);
      })
      .catch(() => {})
      .finally(() => setLoadingData(false));
  }, [eventId]);

  useEffect(() => {
    if (!eventId) return;
    setStoredActiveEventId(eventId);
    fetchNoche();
    const i = setInterval(fetchNoche, 8000);
    return () => clearInterval(i);
  }, [eventId, fetchNoche]);

  const handleEventChange = (id: string) => {
    setEventId(id);
    setData(null);
    setStoredActiveEventId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('eventId', id);
    window.history.replaceState({}, '', url.pathname + url.search);
  };

  if (loadingEvents) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!events.length) {
    return (
      <div className="space-y-6">
        <PageHeader title="Modo noche" description="Operación en puerta durante el evento" />
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No hay eventos publicados. Publica uno en Eventos para empezar.
          </CardContent>
        </Card>
      </div>
    );
  }

  const pct = data?.capacity?.percent ?? 0;
  const isCritical = pct >= 95;
  const isWarning = pct >= 80;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <PageHeader
          title="Modo noche"
          description="Supervisión en vivo: aforo, accesos y ventas del evento activo"
        />
        <div className="flex items-center gap-2 shrink-0">
          <Select value={eventId} onValueChange={handleEventChange}>
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder="Evento activo" />
            </SelectTrigger>
            <SelectContent>
              {events.map((ev) => (
                <SelectItem key={ev.id} value={ev.id}>{ev.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={fetchNoche} aria-label="Actualizar">
            <RefreshCw className={`h-4 w-4 ${loadingData ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {data && (
        <>
          <Card className={isCritical ? 'border-red-500/50' : isWarning ? 'border-yellow-500/50' : ''}>
            <CardContent className="p-6 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-xl font-bold">{data.event.name}</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {data.event.date
                      ? new Date(data.event.date).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })
                      : '—'}
                    {data.event.doorsOpen ? ` · Puertas ${data.event.doorsOpen}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[data.event.venue, data.event.city].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {isCritical && <Badge variant="destructive">Casi lleno</Badge>}
                  {isWarning && !isCritical && (
                    <Badge variant="secondary" className="gap-1">
                      <AlertTriangle className="h-3 w-3" /> +80%
                    </Badge>
                  )}
                  <Badge variant="outline">{pct}% aforo</Badge>
                </div>
              </div>

              <div className="flex items-end gap-3">
                <Users className="h-7 w-7 text-primary shrink-0" />
                <span className="font-display text-5xl font-bold tabular-nums">
                  {data.capacity.current}
                </span>
                <span className="text-muted-foreground text-lg mb-1">
                  / {data.capacity.max} dentro
                </span>
              </div>

              <CapacityBar
                current={data.capacity.current}
                max={data.capacity.max}
                sold={data.capacity.sold}
                size="lg"
              />

              <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
                <span><strong className="text-foreground">{data.capacity.sold}</strong> vendidas</span>
                <span><strong className="text-foreground">{data.capacity.pending}</strong> por entrar</span>
                <span className="flex items-center gap-1">
                  <TrendingUp className="h-3.5 w-3.5" />
                  +{data.capacity.entryRate5min} entradas en 5 min
                </span>
                {(data.capacity.rejectionRate5min ?? 0) > 20 && (
                  <span className="flex items-center gap-1 text-yellow-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {data.capacity.rejectionRate5min}% rechazados
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Button asChild size="lg" className="h-auto py-4 flex-col gap-2">
              <Link href={accesoHref(eventId, 'scan')}>
                <QrCode className="h-6 w-6" />
                <span>Escáner</span>
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary" className="h-auto py-4 flex-col gap-2">
              <Link href={accesoHref(eventId, 'taquilla')}>
                <Ticket className="h-6 w-6" />
                <span>Taquilla</span>
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-auto py-4 flex-col gap-2">
              <Link href={`/admin/aforo`}>
                <Users className="h-6 w-6" />
                <span>Aforo</span>
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-auto py-4 flex-col gap-2">
              <Link href={`/admin/ventas?eventId=${encodeURIComponent(eventId)}`}>
                <ShoppingCart className="h-6 w-6" />
                <span>Ventas</span>
              </Link>
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button asChild variant="outline" className="gap-2 justify-start">
              <Link href={`/admin/invitaciones?eventId=${encodeURIComponent(eventId)}`}>
                <UserPlus className="h-4 w-4" /> Invitaciones
              </Link>
            </Button>
            <Button asChild variant="outline" className="gap-2 justify-start">
              <Link href={`/admin/escaneos?eventId=${encodeURIComponent(eventId)}`}>
                <ScanLine className="h-4 w-4" /> Historial escaneos
              </Link>
            </Button>
          </div>
          <Button asChild variant="ghost" className="w-full gap-2 text-muted-foreground">
            <Link href={accesoHref(eventId, 'invitaciones')}>
              Listas RRPP en puerta
              <ArrowRight className="h-4 w-4 ml-auto" />
            </Link>
          </Button>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm">Últimas ventas</h3>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/admin/ventas?eventId=${encodeURIComponent(eventId)}`}>Ver todas</Link>
                  </Button>
                </div>
                {data.recentOrders.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">Sin ventas aún</p>
                ) : (
                  <ul className="space-y-2">
                    {data.recentOrders.map((o) => (
                      <li key={o.id}>
                        <Link
                          href={`/admin/ventas?id=${o.id}`}
                          className="flex items-center justify-between gap-2 p-2 rounded-md hover:bg-muted/60 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="font-medium truncate">
                              {o.buyerName} {o.buyerLastName}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {channelLabels[o.channel] ?? o.channel}
                              {' · '}
                              {o._count.tickets} entradas
                            </p>
                          </div>
                          <span className="font-bold text-primary shrink-0">
                            {o.totalAmount.toFixed(2)}€
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ScanLine className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm">Últimos escaneos</h3>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/admin/escaneos?eventId=${encodeURIComponent(eventId)}`}>Ver todos</Link>
                  </Button>
                </div>
                {data.recentScans.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">Sin escaneos aún</p>
                ) : (
                  <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                    {data.recentScans.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-center justify-between gap-2 text-sm py-1.5 border-b border-border/40 last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{s.holderName}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {scanResultLabel[s.result] ?? s.result}
                            {s.ticketType ? ` · ${s.ticketType}` : ''}
                          </p>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                          {new Date(s.createdAt).toLocaleTimeString('es-ES', {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'Europe/Madrid',
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {(data.topScanners?.length ?? 0) > 0 && (
                  <div className="pt-2 border-t border-border flex flex-wrap gap-1.5">
                    {data.topScanners.map((s, i) => (
                      <Badge key={`${s.name}-${i}`} variant="outline" className="text-xs">
                        {s.name}: {s.count}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {!data && !loadingData && eventId && (
        <p className="text-center text-muted-foreground py-12">No se pudo cargar el evento</p>
      )}
      {!data && loadingData && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}
    </div>
  );
}
