'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Event, TicketType } from '@prisma/client';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { QrCode, Users, RefreshCw, Keyboard, Camera, LogOut, Ticket, UserPlus, TrendingUp, AlertTriangle } from 'lucide-react';
import { signOut } from 'next-auth/react';
import dynamic from 'next/dynamic';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TaquillaPanel from './taquilla-panel';
import InvitationsPanel from './invitations-panel';

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
};

export type EventWithTicketTypes = Event & { ticketTypes: TicketType[] };

export default function AccessClient() {
  const { data: session } = useSession() || {};
  const [events, setEvents] = useState<EventWithTicketTypes[]>([]);
  const [selectedEvent, setSelectedEvent] = useState('');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [capacity, setCapacity] = useState({ current: 0, max: 0, entryRate5min: 0, rejectionRate5min: null as number | null });
  const [mode, setMode] = useState<'camera' | 'manual'>('camera');
  const [manualCode, setManualCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadEvents = useCallback(() => {
    fetch('/api/events?status=PUBLISHED')
      .then((r) => r.json())
      .then((data) => {
        setEvents(data ?? []);
        setSelectedEvent((prev) => prev || (data?.[0]?.id ?? ''));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const refreshCapacity = useCallback(() => {
    if (!selectedEvent) return;
    fetch(`/api/access/capacity?eventId=${selectedEvent}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.error) return;
        setCapacity({
          current: data?.current ?? 0,
          max: data?.max ?? 0,
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

  const handleScan = useCallback(async (qrCode: string) => {
    if (scanning || !qrCode) return;
    setScanning(true);
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrCode, eventId: selectedEvent || undefined }),
      });
      const data = await res.json();
      setScanResult(data);

      // Update capacity if valid
      if (data?.result === 'VALID') {
        setCapacity((prev) => ({ ...prev, current: (prev?.current ?? 0) + 1 }));
        // Also update events list
        setEvents((prev) => (prev ?? []).map((e) =>
          e?.id === selectedEvent ? { ...e, currentCount: (e?.currentCount ?? 0) + 1 } : e
        ));
      }

      // Clear result after 4 seconds
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setScanResult(null);
        setScanning(false);
      }, 4000);
    } catch {
      setScanResult({ result: 'ERROR', message: 'Error de conexión', color: 'red' });
      setScanning(false);
    }
  }, [scanning, selectedEvent]);

  const handleManualSubmit = () => {
    if (manualCode?.trim()) {
      handleScan(manualCode.trim());
      setManualCode('');
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
              {scanResult?.result === 'VALID' ? '✅' : scanResult?.result === 'DUPLICATE' ? '🔁' : scanResult?.result === 'WRONG_EVENT' ? '⚠️' : '❌'}
            </p>
            <p className="text-2xl md:text-4xl font-bold mb-4">{scanResult?.message ?? ''}</p>
            {scanResult?.ticketType && <p className="text-lg opacity-80">Tipo: {scanResult.ticketType}</p>}
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
            <Select value={selectedEvent} onValueChange={setSelectedEvent}>
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
                <span className="font-bold text-xl">{capacity?.current ?? 0} / {capacity?.max ?? 0}</span>
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
                className={`h-2 rounded-full transition-all ${capacityPercent >= 95 ? 'bg-red-500' : capacityPercent >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`}
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

        <Tabs defaultValue="scan" className="space-y-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="scan" className="gap-1.5 text-xs sm:text-sm"><QrCode className="h-3.5 w-3.5" /> Escáner</TabsTrigger>
            <TabsTrigger value="taquilla" className="gap-1.5 text-xs sm:text-sm"><Ticket className="h-3.5 w-3.5" /> Taquilla</TabsTrigger>
            <TabsTrigger value="invitaciones" className="gap-1.5 text-xs sm:text-sm"><UserPlus className="h-3.5 w-3.5" /> Invitaciones</TabsTrigger>
          </TabsList>

          <TabsContent value="scan" className="space-y-4">
        {/* Mode toggle */}
        <div className="flex gap-2">
          <Button variant={mode === 'camera' ? 'default' : 'outline'} className="flex-1 gap-2" onClick={() => setMode('camera')}>
            <Camera className="h-4 w-4" /> Cámara
          </Button>
          <Button variant={mode === 'manual' ? 'default' : 'outline'} className="flex-1 gap-2" onClick={() => setMode('manual')}>
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
                  placeholder="Introduce código QR"
                  value={manualCode}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setManualCode(e?.target?.value ?? '')}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e?.key === 'Enter' && handleManualSubmit()}
                  autoFocus
                />
                <Button onClick={handleManualSubmit} disabled={!manualCode?.trim()}>Validar</Button>
              </div>
            </CardContent>
          </Card>
        )}
          </TabsContent>

          <TabsContent value="taquilla">
            <TaquillaPanel events={events} selectedEvent={selectedEvent} onSold={loadEvents} />
          </TabsContent>

          <TabsContent value="invitaciones">
            <InvitationsPanel selectedEvent={selectedEvent} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
