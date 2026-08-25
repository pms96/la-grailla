'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Event } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, RefreshCw, Search, ScanLine } from 'lucide-react';
import { PageHeader } from '@/components/layouts/page-header';
import {
  getStoredActiveEventId,
  pickDefaultActiveEventId,
  setStoredActiveEventId,
} from '@/lib/active-event';

type ScanRow = {
  id: string;
  result: string;
  createdAt: string;
  event: { id: string; name: string };
  ticket: {
    id: string;
    qrCode: string;
    holderName: string;
    status: string;
    ticketType: { name: string } | null;
  };
  scanner: { id: string; name: string | null; email: string | null } | null;
};

const RESULT_OPTIONS = [
  { value: 'all', label: 'Todos los resultados' },
  { value: 'VALID', label: 'Válido' },
  { value: 'DUPLICATE', label: 'Duplicado' },
  { value: 'INVALID', label: 'Inválido' },
  { value: 'CANCELLED', label: 'Anulado' },
  { value: 'WRONG_EVENT', label: 'Otro evento' },
];

const resultVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  VALID: 'default',
  DUPLICATE: 'secondary',
  INVALID: 'destructive',
  CANCELLED: 'destructive',
  WRONG_EVENT: 'outline',
};

const resultLabel: Record<string, string> = {
  VALID: 'Válido',
  DUPLICATE: 'Duplicado',
  INVALID: 'Inválido',
  CANCELLED: 'Anulado',
  WRONG_EVENT: 'Otro evento',
  ERROR: 'Error',
};

export default function EscaneosPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventId, setEventId] = useState('all');
  const [result, setResult] = useState('all');
  const [q, setQ] = useState('');
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);

  useEffect(() => {
    fetch('/api/admin/events')
      .then((r) => r.json())
      .then((list: Event[]) => {
        const published = (list ?? []).filter((e) => e.status === 'PUBLISHED' || e.status === 'FINISHED');
        setEvents(published);
        const fromUrl = new URLSearchParams(window.location.search).get('eventId');
        const stored = getStoredActiveEventId();
        if (fromUrl && (list ?? []).some((e) => e.id === fromUrl)) {
          setEventId(fromUrl);
        } else if (stored && published.some((e) => e.id === stored)) {
          setEventId(stored);
        } else {
          const def = pickDefaultActiveEventId(published);
          if (def) setEventId(def);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingEvents(false));
  }, []);

  const fetchScans = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (eventId !== 'all') params.set('eventId', eventId);
    if (result !== 'all') params.set('result', result);
    if (q.trim()) params.set('q', q.trim());
    params.set('take', '80');
    fetch(`/api/admin/scans?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        setScans(Array.isArray(d?.scans) ? d.scans : []);
        setTotal(d?.total ?? 0);
      })
      .catch(() => {
        setScans([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [eventId, result, q]);

  useEffect(() => {
    if (loadingEvents) return;
    const t = setTimeout(fetchScans, 200);
    return () => clearTimeout(t);
  }, [fetchScans, loadingEvents]);

  useEffect(() => {
    if (loadingEvents || eventId === 'all') return;
    const i = setInterval(fetchScans, 10000);
    return () => clearInterval(i);
  }, [fetchScans, loadingEvents, eventId]);

  const handleEventChange = (id: string) => {
    setEventId(id);
    if (id !== 'all') setStoredActiveEventId(id);
    const url = new URL(window.location.href);
    if (id === 'all') url.searchParams.delete('eventId');
    else url.searchParams.set('eventId', id);
    window.history.replaceState({}, '', url.pathname + url.search);
  };

  if (loadingEvents) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <PageHeader
          title="Historial de escaneos"
          description="Consultar accesos validados y rechazos por evento o código QR"
        />
        <Button variant="outline" className="gap-2 shrink-0" onClick={fetchScans}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Actualizar
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Buscar por titular o código QR…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={eventId} onValueChange={handleEventChange}>
          <SelectTrigger className="w-full sm:w-52">
            <SelectValue placeholder="Evento" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los eventos</SelectItem>
            {events.map((ev) => (
              <SelectItem key={ev.id} value={ev.id}>{ev.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={result} onValueChange={setResult}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="Resultado" />
          </SelectTrigger>
          <SelectContent>
            {RESULT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground">
        {total} registro{total === 1 ? '' : 's'}
        {scans.length < total ? ` · mostrando ${scans.length}` : ''}
      </p>

      {loading && scans.length === 0 ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : scans.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            <ScanLine className="h-8 w-8 mx-auto mb-3 opacity-40" />
            No hay escaneos con estos filtros
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {scans.map((s) => (
            <Card key={s.id}>
              <CardContent className="p-3 sm:p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium truncate">{s.ticket?.holderName ?? '—'}</p>
                    <Badge variant={resultVariant[s.result] ?? 'outline'} className="text-xs">
                      {resultLabel[s.result] ?? s.result}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {s.event?.name ?? '—'}
                    {s.ticket?.ticketType?.name ? ` · ${s.ticket.ticketType.name}` : ''}
                    {s.scanner?.name || s.scanner?.email
                      ? ` · ${s.scanner.name || s.scanner.email}`
                      : ''}
                  </p>
                  <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
                    {s.ticket?.qrCode ?? s.ticket?.id ?? '—'}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm tabular-nums">
                    {new Date(s.createdAt).toLocaleTimeString('es-ES', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      timeZone: 'Europe/Madrid',
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(s.createdAt).toLocaleDateString('es-ES', {
                      day: '2-digit',
                      month: 'short',
                      timeZone: 'Europe/Madrid',
                    })}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
