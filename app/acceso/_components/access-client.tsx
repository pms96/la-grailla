'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Event, TicketType } from '@prisma/client';
import type { WithNumberFields } from '@/lib/prisma';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { QrCode, Users, RefreshCw, Keyboard, Camera, LogOut, Ticket, UserPlus, TrendingUp, AlertTriangle, Moon, Search } from 'lucide-react';
import { doorFailure, isDoorVerdict } from '@/lib/door-errors';
import { signOut } from 'next-auth/react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TaquillaPanel from './taquilla-panel';
import InvitationsPanel from './invitations-panel';
import {
  getStoredActiveEventId,
  pickDefaultActiveEventId,
  setStoredActiveEventId,
} from '@/lib/active-event';

const QrScanner = dynamic(() => import('./qr-scanner'), { ssr: false });

type ScanResult = {
  result: string;
  message: string;
  color: string;
  holderName?: string;
  ticketType?: string;
  entryTime?: string;
  eventName?: string;
  eventDate?: string;
  /** Solo en el veredicto de duplicado: lo que necesita el ADMIN para autorizar una reentrada (H-077). */
  ticketId?: string;
  /** Duplicado que es un reintento de la misma puerta (H-074): ámbar, sin botón de reentrada. */
  retry?: boolean;
};

/** Un asistente encontrado en la búsqueda manual (`GET /api/access/search`). */
type FoundTicket = {
  ticketId: string;
  holderName: string;
  ticketType: string | null;
  status: string;
  entryTime: string | null;
  buyerName: string;
  buyerEmail: string;
  orderRef: string;
  admittable: boolean;
  blockedMessage: string | null;
};

/** Qué se admite: una lectura de QR, o una admisión manual de un asistente encontrado en la búsqueda. */
type Admission = { qrCode: string } | { ticketId: string };

/** Por qué no se puede admitir a un asistente (el servidor ya da el motivo si es del pedido o del evento). */
function foundNote(t: FoundTicket): string {
  if (t.blockedMessage) return t.blockedMessage;
  if (t.status === 'USED') {
    const at = t.entryTime ? new Date(t.entryTime).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }) : '';
    return `YA ENTRÓ${at ? ` a las ${at}` : ''}`;
  }
  if (t.status === 'PENDING') return 'PAGO NO CONFIRMADO';
  return 'ENTRADA ANULADA';
}

export type EventWithTicketTypes = Event & { ticketTypes: WithNumberFields<TicketType, 'price'>[] };

/** Lo que el escáner necesita de un evento (`GET /api/access/events`, que sigue vivo con la licencia vencida). */
type DoorEvent = Pick<Event, 'id' | 'name' | 'date' | 'status' | 'currentCount' | 'maxCapacity'>;

export default function AccessClient() {
  const { data: session } = useSession() || {};
  const isAdmin = session?.user?.role === 'ADMIN';
  const [events, setEvents] = useState<DoorEvent[]>([]);
  // Solo para la pestaña de taquilla (necesita los tipos de entrada y su precio): es una VENTA, así que con la licencia vencida o el
  // módulo apagado esta lectura falla y la lista queda vacía, sin afectar al escáner.
  const [saleEvents, setSaleEvents] = useState<EventWithTicketTypes[]>([]);
  const [selectedEvent, setSelectedEvent] = useState('');
  const [activeTab, setActiveTab] = useState('scan');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [capacity, setCapacity] = useState({ current: 0, max: 0, sold: 0, entryRate5min: 0, rejectionRate5min: null as number | null });
  const [mode, setMode] = useState<'camera' | 'manual'>('camera');
  const [manualCode, setManualCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<FoundTicket[] | null>(null);
  const [foundTruncated, setFoundTruncated] = useState(false);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadEvents = useCallback(() => {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const fromUrl = params.get('eventId');
    const tab = params.get('tab');
    if (tab === 'scan' || tab === 'taquilla' || tab === 'invitaciones') {
      setActiveTab(tab);
    }

    fetch('/api/events?status=PUBLISHED')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: EventWithTicketTypes[]) => setSaleEvents(Array.isArray(data) ? data : []))
      .catch(() => setSaleEvents([]));

    fetch('/api/access/events')
      .then((r) => r.json())
      .then((data: DoorEvent[]) => {
        const list = Array.isArray(data) ? data : [];
        setEvents(list);
        setSelectedEvent((prev) => {
          if (prev && list.some((e) => e.id === prev)) return prev;
          if (fromUrl && list.some((e) => e.id === fromUrl)) return fromUrl;
          const stored = getStoredActiveEventId();
          if (stored && list.some((e) => e.id === stored)) return stored;
          return pickDefaultActiveEventId(list) || list[0]?.id || '';
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    if (selectedEvent) setStoredActiveEventId(selectedEvent);
  }, [selectedEvent]);

  const handleEventChange = (id: string) => {
    // Los resultados de la búsqueda son del evento anterior: con su botón «Admitir» solo darían un WRONG_EVENT.
    setFound(null);
    setSearchMessage(null);
    setSelectedEvent(id);
    setStoredActiveEventId(id);
  };

  const refreshCapacity = useCallback(() => {
    if (!selectedEvent) return;
    fetch(`/api/access/capacity?eventId=${selectedEvent}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.error) return;
        setCapacity({
          current: data?.current ?? 0,
          max: data?.max ?? 0,
          sold: data?.sold ?? 0,
          entryRate5min: data?.entryRate5min ?? 0,
          rejectionRate5min: data?.rejectionRate5min ?? null,
        });
      })
      .catch(() => {});
  }, [selectedEvent]);

  useEffect(() => {
    refreshCapacity();
    const i = setInterval(refreshCapacity, 8000);
    return () => clearInterval(i);
  }, [refreshCapacity]);

  const handleScan = useCallback(async (admission: Admission | string) => {
    const payload: Admission = typeof admission === 'string' ? { qrCode: admission } : admission;
    if (scanning || ('qrCode' in payload && !payload.qrCode)) return;
    setScanning(true);

    // Clear result after 4 seconds (también cuando falla: la pantalla nunca se queda bloqueada).
    // Un duplicado visto por un ADMIN se queda 8 s: es el tiempo para pulsar «Permitir reentrada» (H-077).
    const clearLater = (ms = 4000) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setScanResult(null);
        setScanning(false);
      }, ms);
    };

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, eventId: selectedEvent || undefined }),
        // Con la wifi del recinto degradada una conexión colgada no falla: sin tope, `scanning` se quedaba en true y la puerta ignoraba lecturas.
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json().catch(() => null);
      // Un 429, 401 o 500 no trae veredicto: se explica qué ha pasado (P1-06) en vez de pintar un ❌ sin texto.
      const verdict: ScanResult = isDoorVerdict(data) ? data : doorFailure(res.status, (data as { error?: unknown } | null)?.error, (data as { code?: unknown } | null)?.code);
      setScanResult(verdict);

      // Update capacity if valid
      if (verdict.result === 'VALID') {
        setCapacity((prev) => ({ ...prev, current: (prev?.current ?? 0) + 1 }));
        // Also update events list
        setEvents((prev) => (prev ?? []).map((e) =>
          e?.id === selectedEvent ? { ...e, currentCount: (e?.currentCount ?? 0) + 1 } : e
        ));
        // Una admisión manual ya está hecha: se quita de la lista para no admitirla dos veces.
        if ('ticketId' in payload) setFound((prev) => (prev ?? []).map((t) => (t.ticketId === payload.ticketId ? { ...t, status: 'USED', admittable: false, entryTime: new Date().toISOString() } : t)));
      }
      clearLater(canAllowReentry(verdict) ? 8000 : 4000);
    } catch {
      setScanResult(doorFailure(null));
      clearLater();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, selectedEvent, isAdmin]);

  // El ADMIN autoriza que alguien que ya entró vuelva a entrar (salió a fumar): queda registrado, no suma a «han entrado» (H-077).
  const canAllowReentry = (v: ScanResult | null) => isAdmin && v?.result === 'DUPLICATE' && !v.retry && Boolean(v.ticketId);
  const allowReentry = async (ticketId: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    try {
      const res = await fetch('/api/scan/reentry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, eventId: selectedEvent }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json().catch(() => null);
      setScanResult(isDoorVerdict(data) ? data : doorFailure(res.status, (data as { error?: unknown } | null)?.error, (data as { code?: unknown } | null)?.code));
    } catch {
      setScanResult(doorFailure(null));
    }
    timeoutRef.current = setTimeout(() => {
      setScanResult(null);
      setScanning(false);
    }, 4000);
  };

  const handleSearch = async () => {
    const q = manualCode.trim();
    if (!selectedEvent) {
      setSearchMessage('Elige primero el evento');
      return;
    }
    if (q.length < 3) {
      setSearchMessage('Escribe al menos 3 caracteres');
      return;
    }
    setSearching(true);
    setSearchMessage(null);
    try {
      const res = await fetch(`/api/access/search?eventId=${encodeURIComponent(selectedEvent)}&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFound(null);
        setSearchMessage(typeof data?.error === 'string' && res.status !== 401 ? data.error : doorFailure(res.status).message);
        return;
      }
      const list: FoundTicket[] = Array.isArray(data?.results) ? data.results : [];
      setFound(list);
      setFoundTruncated(Boolean(data?.truncated));
      if (list.length === 0) setSearchMessage('No hay ninguna entrada que coincida en este evento');
    } catch {
      setFound(null);
      setSearchMessage(doorFailure(null).message);
    } finally {
      setSearching(false);
    }
  };

  const bgColor = scanResult?.color === 'green'
    ? 'bg-green-500'
    : scanResult?.color === 'red'
    ? 'bg-red-500'
    : scanResult?.color === 'yellow'
    ? 'bg-yellow-500'
    : '';

  const capacityPercent = (capacity?.max ?? 0) > 0
    ? Math.round(((capacity?.current ?? 0) / (capacity?.max ?? 1)) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Full-screen scan result overlay */}
      {scanResult && (
        <div className={`fixed inset-0 z-50 ${bgColor} flex items-center justify-center p-8 transition-all`} onClick={() => { setScanResult(null); setScanning(false); }}>
          <div className="text-center text-white max-w-lg">
            <p className="text-4xl md:text-6xl font-display font-bold mb-4">
              {scanResult?.result === 'VALID' ? '✅' : scanResult?.result === 'DUPLICATE' ? '🔁' : scanResult?.result === 'WRONG_EVENT' || scanResult?.result === 'ERROR' ? '⚠️' : '❌'}
            </p>
            <p className="text-2xl md:text-4xl font-bold mb-4">{scanResult?.message ?? ''}</p>
            {scanResult?.ticketType && <p className="text-lg opacity-80">Tipo: {scanResult.ticketType}</p>}
            {canAllowReentry(scanResult) && scanResult?.ticketId && (
              <button
                type="button"
                className="mt-6 rounded-lg bg-white px-6 py-3 text-lg font-semibold text-black shadow-lg"
                onClick={(e) => {
                  e.stopPropagation();
                  void allowReentry(scanResult.ticketId as string);
                }}
              >
                Permitir reentrada
              </button>
            )}
            <p className="text-sm opacity-60 mt-6">Toca para continuar</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="border-b border-border bg-background/95 backdrop-blur">
        <div className="max-w-[1200px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <QrCode className="h-6 w-6 text-primary" />
            <h1 className="font-display font-bold text-lg">Control de Acceso</h1>
          </div>
          <div className="flex items-center gap-2">
            {session?.user?.role === 'ADMIN' && (
              <Button variant="outline" size="sm" className="gap-1.5" asChild>
                <Link href={`/admin/noche?eventId=${encodeURIComponent(selectedEvent)}`}>
                  <Moon className="h-3.5 w-3.5" /> Modo noche
                </Link>
              </Button>
            )}
            <Badge variant="outline">{session?.user?.role ?? ''}</Badge>
            <Button variant="ghost" size="icon-sm" onClick={() => signOut?.({ callbackUrl: '/auth/login' })}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-[760px] mx-auto px-4 py-6 space-y-4">
        {/* Event selector */}
        <Card>
          <CardContent className="p-4">
            <Select value={selectedEvent} onValueChange={handleEventChange}>
              <SelectTrigger><SelectValue placeholder="Selecciona evento" /></SelectTrigger>
              <SelectContent>
                {(events ?? []).map((ev) => (
                  <SelectItem key={ev?.id} value={ev?.id ?? ''}>{ev?.name ?? ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Capacity */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                <div>
                  <span className="font-bold text-xl">{capacity?.current ?? 0} / {capacity?.max ?? 0}</span>
                  {/* «han entrado» es un acumulado de admitidos: no descuenta a quien sale (H-077). */}
                  <p className="text-xs text-muted-foreground">han entrado · {capacity?.sold ?? 0} entradas vendidas</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={capacityPercent >= 95 ? 'destructive' : capacityPercent >= 80 ? 'secondary' : 'outline'}>
                  {capacityPercent}%
                </Badge>
                <Button variant="ghost" size="icon-sm" onClick={refreshCapacity}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="w-full bg-muted rounded-full h-2 mt-2">
              <div
                className={`h-2 rounded-full transition-[width] duration-normal ease-out ${capacityPercent >= 95 ? 'bg-red-500' : capacityPercent >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`}
                style={{ width: `${Math.min(capacityPercent, 100)}%` }}
              />
            </div>
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3.5 w-3.5" /> +{capacity?.entryRate5min ?? 0} en 5 min
              </span>
              {(capacity?.rejectionRate5min ?? 0) > 20 && (
                <span className="flex items-center gap-1 text-yellow-500">
                  <AlertTriangle className="h-3.5 w-3.5" /> {capacity.rejectionRate5min}% de escaneos rechazados
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="scan" className="gap-1.5 text-xs sm:text-sm"><QrCode className="h-3.5 w-3.5" /> Escáner</TabsTrigger>
            <TabsTrigger value="taquilla" className="gap-1.5 text-xs sm:text-sm"><Ticket className="h-3.5 w-3.5" /> Taquilla</TabsTrigger>
            <TabsTrigger value="invitaciones" className="gap-1.5 text-xs sm:text-sm"><UserPlus className="h-3.5 w-3.5" /> Invitaciones</TabsTrigger>
          </TabsList>

          <TabsContent value="scan" className="space-y-4">
        {/* Mode toggle */}
        <div className="flex gap-2">
          <Button size="lg" variant={mode === 'camera' ? 'default' : 'outline'} className="flex-1 gap-2" onClick={() => setMode('camera')}>
            <Camera className="h-4 w-4" /> Cámara
          </Button>
          <Button size="lg" variant={mode === 'manual' ? 'default' : 'outline'} className="flex-1 gap-2" onClick={() => setMode('manual')}>
            <Keyboard className="h-4 w-4" /> Manual
          </Button>
        </div>

        {/* Scanner / Manual input */}
        {mode === 'camera' ? (
          <Card>
            <CardContent className="p-4">
              <QrScanner onScan={handleScan} />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-4">
              <div className="flex gap-2">
                <Input
                  size="lg"
                  placeholder="Nombre, email, referencia o código QR"
                  value={manualCode}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setManualCode(e?.target?.value ?? '')}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e?.key === 'Enter' && handleSearch()}
                  autoFocus
                />
                <Button size="lg" className="gap-2" onClick={handleSearch} disabled={manualCode.trim().length < 3 || searching}>
                  <Search className="h-4 w-4" /> Buscar
                </Button>
              </div>
              {searchMessage && <p className="text-sm text-muted-foreground mt-3" role="status">{searchMessage}</p>}
              {found && found.length > 0 && (
                <ul className="mt-3 divide-y divide-border">
                  {found.map((t) => (
                    <li key={t.ticketId} className="py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{t.holderName}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {[t.ticketType, t.buyerName, t.buyerEmail, `Ref. ${t.orderRef}`].filter(Boolean).join(' · ')}
                        </p>
                        {!t.admittable && <p className="text-xs font-semibold text-red-500 mt-0.5">{foundNote(t)}</p>}
                      </div>
                      {t.admittable && (
                        <Button size="lg" disabled={scanning} onClick={() => handleScan({ ticketId: t.ticketId })}>Admitir</Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {foundTruncated && <p className="text-xs text-muted-foreground mt-2">Hay más resultados: afina la búsqueda.</p>}
            </CardContent>
          </Card>
        )}
          </TabsContent>

          <TabsContent value="taquilla">
            <TaquillaPanel events={saleEvents} selectedEvent={selectedEvent} onSold={loadEvents} />
          </TabsContent>

          <TabsContent value="invitaciones">
            <InvitationsPanel selectedEvent={selectedEvent} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
