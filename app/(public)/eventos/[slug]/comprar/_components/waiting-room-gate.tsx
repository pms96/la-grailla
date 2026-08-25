'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Ticket, Hourglass, RotateCcw, ArrowLeft, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from '@/components/ui/animate';
import { toast } from 'sonner';
import BuyTicketsForm, { type EventData } from './buy-tickets-form';

type WaitingRoomEvent = EventData & { waitingRoomEnabled: boolean };

type QueueState =
  | { status: 'CHECKING' }
  | { status: 'WAITING'; token: string; position: number; message: string | null }
  | { status: 'ADMITTED'; token: string; expiresAt: string }
  | { status: 'EXPIRED' }
  | { status: 'STUCK'; reason: 'slow' | 'network' };

type QueueApiResult = {
  status: string;
  token?: string | null;
  position?: number;
  expiresAt?: string;
  waitingRoomMessage?: string | null;
};

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

// `Number(header) * 1000 || 5000` trataba un `Retry-After: 0` real (el
// servidor pidiendo reintentar ya mismo) como "sin cabecera", porque
// `0 || 5000` cae al valor por defecto — retrasaba el reintento 5s de más
// justo cuando el servidor pedía lo contrario.
function retryAfterMs(res: Response, fallbackMs: number): number {
  const raw = res.headers.get('Retry-After');
  const seconds = raw === null ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
}

const CHECKING_SLOW_MS = 12000;
const MAX_NETWORK_RETRIES_BEFORE_STUCK = 4;

export default function WaitingRoomGate({ event }: { event: WaitingRoomEvent }) {
  const [state, setState] = useState<QueueState>(
    event.waitingRoomEnabled ? { status: 'CHECKING' } : { status: 'ADMITTED', token: '', expiresAt: '' }
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const slowTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const networkFailsRef = useRef(0);
  // Evita que un poll tardío pise un estado STUCK / EXPIRED tras reintento manual.
  const generationRef = useRef(0);
  const joinRef = useRef<() => void>(() => {});
  const pollRef = useRef<() => void>(() => {});

  const clearTimers = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
  };

  const startSlowWatch = useCallback(() => {
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    slowTimerRef.current = setTimeout(() => {
      setState((prev) => (prev.status === 'CHECKING' ? { status: 'STUCK', reason: 'slow' } : prev));
    }, CHECKING_SLOW_MS);
  }, []);

  const scheduleRetry = useCallback((fn: () => void, ms: number, gen: number) => {
    networkFailsRef.current += 1;
    if (networkFailsRef.current >= MAX_NETWORK_RETRIES_BEFORE_STUCK) {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      setState({ status: 'STUCK', reason: 'network' });
      return;
    }
    timeoutRef.current = setTimeout(() => {
      if (generationRef.current !== gen) return;
      fn();
    }, ms);
  }, []);

  const applyResult = useCallback(
    (data: QueueApiResult) => {
      networkFailsRef.current = 0;
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);

      if (data?.token && typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey(event.id), data.token);
      }
      // El token del turno no siempre viaja en cada respuesta (p. ej. si algún
      // endpoint lo omite) — nunca lo pisamos con vacío, siempre caemos al que
      // ya conocíamos en localStorage para no invalidar un turno válido.
      const knownToken =
        data?.token ??
        (typeof window !== 'undefined' ? window.localStorage.getItem(storageKey(event.id)) : null) ??
        '';

      if (data?.status === 'ADMITTED') {
        setState({ status: 'ADMITTED', token: knownToken, expiresAt: data.expiresAt ?? '' });
      } else if (data?.status === 'WAITING') {
        setState({
          status: 'WAITING',
          token: knownToken,
          position: data.position ?? 1,
          message: data.waitingRoomMessage ?? null,
        });
        timeoutRef.current = setTimeout(() => pollRef.current(), pollIntervalFor(data.position ?? 1));
      } else if (data?.status === 'EXPIRED') {
        setState({ status: 'EXPIRED' });
      } else if (data?.status === 'NOT_FOUND' || data?.status === 'COMPLETED') {
        // COMPLETED: el turno guardado ya compró (p. ej. se recarga /comprar
        // después de terminar la compra, o se vuelve atrás desde la pasarela).
        // Ese token ya no representa una espera en curso — no tiene ningún
        // sentido seguir haciendo polling sobre él para siempre. Se limpia y
        // se vuelve a entrar de cero, como con un turno que ya no existe, pero
        // avisando: sin esto, el comprador ve que le meten otra vez en la cola
        // sin explicación y puede pensar que su compra anterior no se guardó.
        if (data.status === 'COMPLETED') {
          toast.info('Ya completaste una compra para este evento. Te llevamos de nuevo a la cola por si quieres más entradas.');
        }
        if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey(event.id));
        setState({ status: 'CHECKING' });
        startSlowWatch();
        joinRef.current();
      } else {
        // Respuesta con 2xx pero una forma que no reconocemos: mejor
        // reintentar que quedarnos colgados sin más pistas.
        timeoutRef.current = setTimeout(() => pollRef.current(), 5000);
      }
    },
    [event.id, startSlowWatch]
  );

  const join = useCallback(async () => {
    const gen = generationRef.current;
    const token = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey(event.id)) : null;
    try {
      const res = await fetch('/api/queue/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: event.id, token }),
      });
      if (generationRef.current !== gen) return;
      const data = (await res.json()) as QueueApiResult;
      // Un 429 (rate limit) o un 5xx no tienen "status" de cola en el body —
      // sin este chequeo, applyResult no reconoce la forma de la respuesta y
      // no hace nada, dejando al comprador colgado en "comprobando" para
      // siempre. Reintentar es lo correcto: el turno, si ya existía, sigue
      // vivo en el servidor aunque esta llamada concreta haya fallado.
      if (!res.ok) {
        scheduleRetry(() => joinRef.current(), retryAfterMs(res, 5000), gen);
        return;
      }
      applyResult(data);
    } catch {
      if (generationRef.current !== gen) return;
      // Fallo de red puntual: reintenta en el siguiente tick en vez de
      // bloquear al comprador con una pantalla de error.
      scheduleRetry(() => joinRef.current(), 3000, gen);
    }
  }, [event.id, applyResult, scheduleRetry]);

  const poll = useCallback(async () => {
    const gen = generationRef.current;
    const token = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey(event.id)) : null;
    if (!token) {
      joinRef.current();
      return;
    }
    try {
      const res = await fetch(`/api/queue/status?eventId=${event.id}&token=${encodeURIComponent(token)}`);
      if (generationRef.current !== gen) return;
      const data = (await res.json()) as QueueApiResult;
      if (!res.ok) {
        scheduleRetry(() => pollRef.current(), retryAfterMs(res, 5000), gen);
        return;
      }
      applyResult(data);
    } catch {
      if (generationRef.current !== gen) return;
      scheduleRetry(() => pollRef.current(), 3000, gen);
    }
  }, [event.id, applyResult, scheduleRetry]);

  joinRef.current = () => {
    void join();
  };
  pollRef.current = () => {
    void poll();
  };

  useEffect(() => {
    if (!event.waitingRoomEnabled) return;
    generationRef.current += 1;
    networkFailsRef.current = 0;
    setState({ status: 'CHECKING' });
    startSlowWatch();
    void join();
    return () => {
      generationRef.current += 1;
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, event.waitingRoomEnabled]);

  const retryFromStuck = () => {
    generationRef.current += 1;
    networkFailsRef.current = 0;
    clearTimers();
    setState({ status: 'CHECKING' });
    startSlowWatch();
    void join();
  };

  const rejoin = () => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey(event.id));
    generationRef.current += 1;
    networkFailsRef.current = 0;
    clearTimers();
    setState({ status: 'CHECKING' });
    startSlowWatch();
    void join();
  };

  if (!event.waitingRoomEnabled) return <BuyTicketsForm event={event} />;

  if (state.status === 'CHECKING') {
    return (
      <FadeIn>
        <div
          className="relative overflow-hidden rounded-lg border border-border bg-card hero-gradient texture-noise p-8 md:p-12 text-center space-y-4"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-lima/10 blur-3xl" />
          <Hourglass className="relative h-8 w-8 text-primary mx-auto animate-pulse" aria-hidden />
          <div className="relative space-y-2">
            <h1 className="font-display text-xl font-bold tracking-tight">Comprobando tu turno…</h1>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Estamos viendo si hay cola para este evento. No cierres la pestaña.
            </p>
          </div>
          <BackToEvent slug={event.slug} />
        </div>
      </FadeIn>
    );
  }

  if (state.status === 'STUCK') {
    return (
      <FadeIn>
        <div className="rounded-lg border border-border bg-card p-8 md:p-12 text-center space-y-4" role="alert">
          {state.reason === 'network' ? (
            <WifiOff className="h-10 w-10 text-muted-foreground mx-auto" aria-hidden />
          ) : (
            <Hourglass className="h-10 w-10 text-muted-foreground mx-auto" aria-hidden />
          )}
          <h1 className="font-display text-xl font-bold tracking-tight">
            {state.reason === 'network' ? 'Sin conexión con la cola' : 'La cola está tardando'}
          </h1>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {state.reason === 'network'
              ? 'No hemos podido contactar con el servidor. Revisa la red e inténtalo de nuevo — tu sitio se conserva en este dispositivo si ya tenías turno.'
              : 'Sigue sin responder. Puedes reintentar sin perder el progreso si ya tenías un turno guardado.'}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button onClick={retryFromStuck} className="gap-2">
              <RotateCcw className="h-4 w-4" /> Reintentar
            </Button>
            <BackToEvent slug={event.slug} asButton />
          </div>
        </div>
      </FadeIn>
    );
  }

  if (state.status === 'WAITING') {
    const ahead = Math.max(0, state.position - 1);
    const statusText =
      state.position <= 1
        ? 'Eres el siguiente — te dejaremos pasar en cuanto se libere un hueco.'
        : `${ahead} persona${ahead === 1 ? '' : 's'} por delante de ti.`;

    return (
      <FadeIn>
        <div className="relative overflow-hidden rounded-lg border border-border bg-card hero-gradient texture-noise p-8 md:p-12 text-center space-y-6">
          <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-lima/10 blur-3xl" />
          <div className="absolute bottom-0 left-0 w-40 h-40 rounded-full bg-neon-pink/8 blur-3xl" />

          <div className="relative brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mx-auto">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lima opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-lima" />
            </span>
            En cola
          </div>

          <div className="relative space-y-1" aria-live="polite">
            <p className="font-display font-semibold text-xs uppercase tracking-wide text-muted-foreground">
              Tu número
            </p>
            <p className="font-display text-7xl md:text-8xl font-bold leading-none tracking-tight text-primary">
              {state.position}
            </p>
            <p className="sr-only">
              Posición {state.position}. {statusText}
            </p>
          </div>

          <p className="relative text-sm text-muted-foreground max-w-sm mx-auto">{statusText}</p>

          {state.message && (
            <p className="relative text-sm text-foreground/80 border-t border-border pt-4 max-w-sm mx-auto">
              {state.message}
            </p>
          )}

          <div className="relative space-y-2 text-xs text-muted-foreground max-w-sm mx-auto">
            <p>Tu turno está guardado en este dispositivo. Si sales y vuelves a esta página, recuperas tu sitio.</p>
            <p>No hace falta refrescar: la cola avanza sola.</p>
          </div>

          <BackToEvent slug={event.slug} />
        </div>
      </FadeIn>
    );
  }

  if (state.status === 'EXPIRED') {
    return (
      <FadeIn>
        <div className="rounded-lg border border-border bg-card p-8 md:p-12 text-center space-y-4" role="alert">
          <Hourglass className="h-10 w-10 text-muted-foreground mx-auto" aria-hidden />
          <h1 className="font-display text-xl font-bold tracking-tight">Tu turno ha terminado</h1>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            Se acabó el tiempo para completar la compra. Puedes volver a la cola — no se ha cobrado nada.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button onClick={rejoin} className="gap-2">
              <RotateCcw className="h-4 w-4" /> Volver a la cola
            </Button>
            <BackToEvent slug={event.slug} asButton />
          </div>
        </div>
      </FadeIn>
    );
  }

  // ADMITTED
  return (
    <div className="space-y-4">
      <div className="brand-sticker text-sm text-lima border-lima/60 shadow-lima/30" role="status" aria-live="polite">
        <Ticket className="h-3.5 w-3.5" /> Es tu turno — completa la compra
      </div>
      {state.expiresAt && (
        <AdmittedCountdown expiresAt={state.expiresAt} onExpire={() => setState({ status: 'EXPIRED' })} />
      )}
      <BuyTicketsForm event={event} queueToken={state.token} />
    </div>
  );
}

function BackToEvent({ slug, asButton }: { slug: string; asButton?: boolean }) {
  if (asButton) {
    return (
      <Button variant="outline" asChild>
        <Link href={`/eventos/${slug}`} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Volver al evento
        </Link>
      </Button>
    );
  }
  return (
    <Link
      href={`/eventos/${slug}`}
      className="relative inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="h-4 w-4" /> Volver al evento
    </Link>
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
    <p
      className={`text-xs font-mono ${low ? 'text-destructive' : 'text-muted-foreground'}`}
      role="timer"
      aria-live={low ? 'assertive' : 'off'}
    >
      Te quedan {minutes}:{String(seconds).padStart(2, '0')} para completar la compra
    </p>
  );
}
