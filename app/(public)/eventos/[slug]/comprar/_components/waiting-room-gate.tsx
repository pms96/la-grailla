'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Ticket, Hourglass, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from '@/components/ui/animate';
import BuyTicketsForm, { type EventData } from './buy-tickets-form';

type WaitingRoomEvent = EventData & { waitingRoomEnabled: boolean };

type QueueState =
  | { status: 'CHECKING' }
  | { status: 'WAITING'; token: string; position: number; message: string | null }
  | { status: 'ADMITTED'; token: string; expiresAt: string }
  | { status: 'EXPIRED' };

// Intervalo de polling adaptativo: cuanta más gente por delante, menos falta
// hace comprobar a menudo. Con miles de personas esperando, hacerlo fijo a
// 3s multiplicaría la carga de barridos en el servidor sin necesidad —
// quien está lejos de su turno no pierde nada por enterarse unos segundos
// más tarde de que ha avanzado.
function pollIntervalFor(position: number): number {
  if (position > 50) return 8000;
  if (position > 10) return 5000;
  return 2000;
}

function storageKey(eventId: string): string {
  return `queue_token_${eventId}`;
}

export default function WaitingRoomGate({ event }: { event: WaitingRoomEvent }) {
  const [state, setState] = useState<QueueState>(
    event.waitingRoomEnabled ? { status: 'CHECKING' } : { status: 'ADMITTED', token: '', expiresAt: '' }
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const join = useCallback(async () => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey(event.id)) : null;
    try {
      const res = await fetch('/api/queue/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: event.id, token }),
      });
      const data = await res.json();
      // Un 429 (rate limit) o un 5xx no tienen "status" de cola en el body —
      // sin este chequeo, applyResult no reconoce la forma de la respuesta y
      // no hace nada, dejando al comprador colgado en "comprobando" para
      // siempre. Reintentar es lo correcto: el turno, si ya existía, sigue
      // vivo en el servidor aunque esta llamada concreta haya fallado.
      if (!res.ok) {
        const retryAfterMs = Number(res.headers.get('Retry-After')) * 1000 || 5000;
        timeoutRef.current = setTimeout(join, retryAfterMs);
        return;
      }
      applyResult(data);
    } catch {
      // Fallo de red puntual: reintenta en el siguiente tick en vez de
      // bloquear al comprador con una pantalla de error.
      timeoutRef.current = setTimeout(join, 3000);
    }
  }, [event.id]);

  const applyResult = (data: { status: string; token?: string | null; position?: number; expiresAt?: string; waitingRoomMessage?: string | null }) => {
    if (data?.token && typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey(event.id), data.token);
    }
    // El token del turno no siempre viaja en cada respuesta (p. ej. si algún
    // endpoint lo omite) — nunca lo pisamos con vacío, siempre caemos al que
    // ya conocíamos en localStorage para no invalidar un turno válido.
    const knownToken =
      data?.token ?? (typeof window !== 'undefined' ? window.localStorage.getItem(storageKey(event.id)) : null) ?? '';
    if (data?.status === 'ADMITTED') {
      setState({ status: 'ADMITTED', token: knownToken, expiresAt: data.expiresAt ?? '' });
    } else if (data?.status === 'WAITING') {
      setState({ status: 'WAITING', token: knownToken, position: data.position ?? 1, message: data.waitingRoomMessage ?? null });
      timeoutRef.current = setTimeout(poll, pollIntervalFor(data.position ?? 1));
    } else if (data?.status === 'EXPIRED') {
      setState({ status: 'EXPIRED' });
    } else if (data?.status === 'NOT_FOUND') {
      if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey(event.id));
      join();
    } else {
      // Respuesta con 2xx pero una forma que no reconocemos: mejor
      // reintentar que quedarnos colgados sin más pistas.
      timeoutRef.current = setTimeout(poll, 5000);
    }
  };

  const poll = useCallback(async () => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey(event.id)) : null;
    if (!token) return join();
    try {
      const res = await fetch(`/api/queue/status?eventId=${event.id}&token=${token}`);
      const data = await res.json();
      if (!res.ok) {
        const retryAfterMs = Number(res.headers.get('Retry-After')) * 1000 || 5000;
        timeoutRef.current = setTimeout(poll, retryAfterMs);
        return;
      }
      applyResult(data);
    } catch {
      timeoutRef.current = setTimeout(poll, 3000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  useEffect(() => {
    if (!event.waitingRoomEnabled) return;
    join();
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, event.waitingRoomEnabled]);

  const rejoin = () => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey(event.id));
    setState({ status: 'CHECKING' });
    join();
  };

  if (!event.waitingRoomEnabled) return <BuyTicketsForm event={event} />;

  if (state.status === 'CHECKING') {
    return (
      <div className="flex justify-center py-24">
        <Hourglass className="h-6 w-6 text-primary animate-pulse" />
      </div>
    );
  }

  if (state.status === 'WAITING') {
    return (
      <FadeIn>
        <div className="relative overflow-hidden rounded-lg border border-border bg-card p-8 md:p-12 text-center space-y-6">
          <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-lima/10 blur-3xl" />
          <div className="absolute bottom-0 left-0 w-40 h-40 rounded-full bg-neon-pink/8 blur-3xl" />

          <div className="relative brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mx-auto">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lima opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-lima" />
            </span>
            En cola
          </div>

          <div className="relative space-y-1">
            <p className="font-display font-semibold text-xs uppercase tracking-wide text-muted-foreground">Tu número</p>
            <p className="font-display text-7xl md:text-8xl font-bold leading-none tracking-tight text-primary">
              {state.position}
            </p>
          </div>

          <p className="relative text-sm text-muted-foreground max-w-sm mx-auto">
            {state.position <= 1
              ? 'Eres el siguiente — te dejaremos pasar en cuanto se libere un hueco.'
              : `${state.position - 1} persona${state.position - 1 === 1 ? '' : 's'} por delante de ti.`}
          </p>

          {state.message && (
            <p className="relative text-sm text-foreground/80 border-t border-border pt-4 max-w-sm mx-auto">{state.message}</p>
          )}

          <p className="relative text-xs text-muted-foreground">
            Tu turno está asegurado — no cierres esta pestaña, avanzará sola.
          </p>
        </div>
      </FadeIn>
    );
  }

  if (state.status === 'EXPIRED') {
    return (
      <FadeIn>
        <div className="rounded-lg border border-border bg-card p-8 md:p-12 text-center space-y-4">
          <Hourglass className="h-10 w-10 text-muted-foreground mx-auto" />
          <h2 className="font-display text-xl font-bold tracking-tight">Tu turno ha terminado</h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            Se acabó el tiempo para completar la compra. Vuelve a la cola para intentarlo de nuevo.
          </p>
          <Button onClick={rejoin} className="gap-2">
            <RotateCcw className="h-4 w-4" /> Volver a la cola
          </Button>
        </div>
      </FadeIn>
    );
  }

  // ADMITTED
  return (
    <div className="space-y-4">
      <div className="brand-sticker text-sm text-lima border-lima/60 shadow-lima/30">
        <Ticket className="h-3.5 w-3.5" /> Es tu turno
      </div>
      {state.expiresAt && <AdmittedCountdown expiresAt={state.expiresAt} onExpire={() => setState({ status: 'EXPIRED' })} />}
      <BuyTicketsForm event={event} queueToken={state.token} />
    </div>
  );
}

function AdmittedCountdown({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  const [remainingMs, setRemainingMs] = useState(() => new Date(expiresAt).getTime() - Date.now());

  useEffect(() => {
    const i = setInterval(() => {
      const remaining = new Date(expiresAt).getTime() - Date.now();
      setRemainingMs(remaining);
      if (remaining <= 0) onExpire();
    }, 1000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const low = totalSeconds <= 60;

  return (
    <p className={`text-xs font-mono ${low ? 'text-destructive' : 'text-muted-foreground'}`}>
      Te quedan {minutes}:{String(seconds).padStart(2, '0')} para completar la compra
    </p>
  );
}
