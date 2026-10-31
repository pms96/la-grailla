'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Ticket, Hourglass, RotateCcw, ArrowLeft, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from '@/components/ui/animate';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { CaptchaWidget } from '@/components/captcha-widget';
import { busyRetryMs, countdownAnnouncement, createTokenStore, isBusyStatus, readJsonSafe, remainingFrom } from '@/lib/queue-client';
import BuyTicketsForm, { type EventData } from './buy-tickets-form';

// Curva de ease-out reforzada (equivalente a --ease-out en globals.css).
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

type WaitingRoomEvent = EventData & { waitingRoomEnabled: boolean };

type QueueState =
  | { status: 'CHECKING' }
  | { status: 'CAPTCHA' }
  | { status: 'WAITING'; token: string; position: number; message: string | null }
  // `remainingMs` es el tiempo restante según el servidor y `receivedAt` el instante (reloj monótono) en que llegó: la cuenta atrás no depende de la hora del dispositivo (H-091).
  | { status: 'ADMITTED'; token: string; expiresAt: string; remainingMs?: number; receivedAt: number }
  | { status: 'EXPIRED' }
  | { status: 'STUCK'; reason: 'slow' | 'network' | 'limit'; message?: string };

type QueueApiResult = {
  status: string;
  /** Texto de error del servidor (en español), p. ej. el del tope de turnos por conexión. */
  error?: string;
  token?: string | null;
  position?: number;
  expiresAt?: string;
  remainingMs?: number;
  waitingRoomMessage?: string | null;
  code?: string;
  // Cuánto esperar antes del siguiente sondeo, decidido por el servidor (P1-12). Ausente en un servidor anterior.
  pollAfterMs?: number;
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

// Lo que pide el servidor manda, pero acotado: un valor absurdo (o 0) no puede dejar al comprador sin enterarse de su turno ni martillear la API.
const MIN_POLL_MS = 1500;
const MAX_POLL_MS = 30000;
function nextPollMs(data: QueueApiResult, position: number): number {
  const asked = data.pollAfterMs;
  if (typeof asked === 'number' && Number.isFinite(asked)) return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, asked));
  return pollIntervalFor(position);
}

// El turno se guarda en localStorage y, si el navegador lo bloquea, en memoria (H-102): ver `createTokenStore`.
const tokens = createTokenStore();

// Un `Retry-After: 0` real (el servidor pidiendo reintentar ya mismo) es un valor válido, no «sin cabecera».
function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

const CHECKING_SLOW_MS = 12000;
const MAX_NETWORK_RETRIES_BEFORE_STUCK = 4;
// Con el servidor «ocupado» (429/5xx) se sigue reintentando con calma, pero no para siempre: pasado esto se ofrece reintentar a mano (~10-20 min).
const MAX_BUSY_RETRIES_BEFORE_STUCK = 40;

export default function WaitingRoomGate({ event }: { event: WaitingRoomEvent }) {
  const [state, setState] = useState<QueueState>(
    event.waitingRoomEnabled ? { status: 'CHECKING' } : { status: 'ADMITTED', token: '', expiresAt: '', receivedAt: 0 }
  );
  const reduceMotion = useReducedMotion();
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const slowTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const networkFailsRef = useRef(0);
  // «Servidor ocupado» (429/5xx, esperado en un lanzamiento): se reintenta con calma y se avisa, sin contarlo como fallo de red (H-090).
  const busyFailsRef = useRef(0);
  const [busy, setBusy] = useState(false);
  // ¿Hay un envío de la compra en curso? Si sí, la caducidad del turno no desmonta el formulario a medias (H-091).
  const submittingRef = useRef(false);
  const onSubmittingChange = useCallback((submitting: boolean) => {
    submittingRef.current = submitting;
  }, []);
  // Evita que un poll tardío pise un estado STUCK / EXPIRED tras reintento manual.
  const generationRef = useRef(0);
  // Token del captcha para el PRÓXIMO intento de entrar en la cola: vale una sola vez, así que se vacía al enviarlo.
  const captchaTokenRef = useRef<string | null>(null);
  // Si el widget no puede cargar se intenta UNA vez entrar sin token (el servidor deja pasar si Cloudflare está caído); si lo rechaza, se queda el aviso.
  const captchaTriedBlindRef = useRef(false);
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

  // El servidor contestó 429/5xx: el turno sigue vivo, se reintenta con calma (lo que pida Retry-After, acotado) sin contarlo como fallo de red (H-090).
  const scheduleBusyRetry = useCallback((fn: () => void, retryAfter: number | null, gen: number) => {
    busyFailsRef.current += 1;
    if (busyFailsRef.current >= MAX_BUSY_RETRIES_BEFORE_STUCK) {
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      setBusy(false);
      setState({ status: 'STUCK', reason: 'slow' });
      return;
    }
    // Mientras hay un aviso de «mucha gente» el aviso de lentitud de 12 s no tiene sentido: ya se explica y se reintenta solo.
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    setBusy(true);
    timeoutRef.current = setTimeout(() => {
      if (generationRef.current !== gen) return;
      fn();
    }, busyRetryMs(retryAfter));
  }, []);

  const applyResult = useCallback(
    (data: QueueApiResult) => {
      networkFailsRef.current = 0;
      busyFailsRef.current = 0;
      setBusy(false);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);

      if (data?.token) tokens.set(event.id, data.token);
      // El token del turno no siempre viaja en cada respuesta (p. ej. si algún
      // endpoint lo omite) — nunca lo pisamos con vacío, siempre caemos al que
      // ya conocíamos para no invalidar un turno válido.
      const knownToken = data?.token ?? tokens.get(event.id) ?? '';

      if (data?.status === 'ADMITTED') {
        setState({ status: 'ADMITTED', token: knownToken, expiresAt: data.expiresAt ?? '', remainingMs: data.remainingMs, receivedAt: performance.now() });
      } else if (data?.status === 'WAITING') {
        setState({
          status: 'WAITING',
          token: knownToken,
          position: data.position ?? 1,
          message: data.waitingRoomMessage ?? null,
        });
        timeoutRef.current = setTimeout(() => pollRef.current(), nextPollMs(data, data.position ?? 1));
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
        tokens.remove(event.id);
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
    const token = tokens.get(event.id);
    const captchaToken = captchaTokenRef.current;
    captchaTokenRef.current = null;
    try {
      const res = await fetch('/api/queue/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: event.id, token, captchaToken }),
      });
      if (generationRef.current !== gen) return;
      // Un 502 de la plataforma trae HTML: sin esto `res.json()` lanzaba y se ignoraba el código y el Retry-After (H-090).
      const data = (await readJsonSafe<QueueApiResult>(res)) ?? ({} as QueueApiResult);
      // Entrar en la cola pide la comprobación de seguridad (solo con captcha activado): se pinta el widget y, con su token, se reintenta.
      if (res.status === 400 && event.captchaSiteKey && (data?.code === 'captcha_required' || data?.code === 'captcha_failed')) {
        if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
        setState({ status: 'CAPTCHA' });
        return;
      }
      // Un 429 (rate limit) o un 5xx no tienen "status" de cola en el body —
      // sin este chequeo, applyResult no reconoce la forma de la respuesta y
      // no hace nada, dejando al comprador colgado en "comprobando" para
      // siempre. Reintentar es lo correcto: el turno, si ya existía, sigue
      // vivo en el servidor aunque esta llamada concreta haya fallado.
      if (!res.ok) {
        // Demasiados turnos abiertos desde esta conexión (oficina, wifi compartido): reintentar en silencio no sirve y pintar «sin conexión» es falso (H-072).
        if (res.status === 429 && data?.code === 'queue_ip_limit') {
          if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
          setState({ status: 'STUCK', reason: 'limit', message: typeof data.error === 'string' ? data.error : undefined });
          return;
        }
        if (isBusyStatus(res.status)) {
          scheduleBusyRetry(() => joinRef.current(), retryAfterSeconds(res), gen);
          return;
        }
        scheduleRetry(() => joinRef.current(), 5000, gen);
        return;
      }
      applyResult(data);
    } catch {
      if (generationRef.current !== gen) return;
      // Fallo de red puntual: reintenta en el siguiente tick en vez de
      // bloquear al comprador con una pantalla de error.
      scheduleRetry(() => joinRef.current(), 3000, gen);
    }
  }, [event.id, event.captchaSiteKey, applyResult, scheduleRetry, scheduleBusyRetry]);

  const poll = useCallback(async () => {
    const gen = generationRef.current;
    const token = tokens.get(event.id);
    if (!token) {
      joinRef.current();
      return;
    }
    try {
      const res = await fetch(`/api/queue/status?eventId=${event.id}&token=${encodeURIComponent(token)}`);
      if (generationRef.current !== gen) return;
      const data = (await readJsonSafe<QueueApiResult>(res)) ?? ({} as QueueApiResult);
      if (!res.ok) {
        if (isBusyStatus(res.status)) {
          scheduleBusyRetry(() => pollRef.current(), retryAfterSeconds(res), gen);
          return;
        }
        scheduleRetry(() => pollRef.current(), 5000, gen);
        return;
      }
      applyResult(data);
    } catch {
      if (generationRef.current !== gen) return;
      scheduleRetry(() => pollRef.current(), 3000, gen);
    }
  }, [event.id, applyResult, scheduleRetry, scheduleBusyRetry]);

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
    busyFailsRef.current = 0;
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
    busyFailsRef.current = 0;
    setBusy(false);
    clearTimers();
    setState({ status: 'CHECKING' });
    startSlowWatch();
    void join();
  };

  const rejoin = () => {
    tokens.remove(event.id);
    generationRef.current += 1;
    networkFailsRef.current = 0;
    busyFailsRef.current = 0;
    setBusy(false);
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
            {busy && <BusyNotice />}
          </div>
          <BackToEvent slug={event.slug} />
        </div>
      </FadeIn>
    );
  }

  if (state.status === 'CAPTCHA') {
    return (
      <FadeIn>
        <div className="rounded-lg border border-border bg-card p-8 md:p-12 text-center space-y-4" role="status" aria-live="polite">
          <Hourglass className="h-8 w-8 text-primary mx-auto" aria-hidden />
          <div className="space-y-2">
            <h1 className="font-display text-xl font-bold tracking-tight">Una comprobación rápida</h1>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Antes de entrar en la cola comprobamos que eres una persona. Suele ser automático y no pierdes tu sitio.
            </p>
          </div>
          <CaptchaWidget
            siteKey={event.captchaSiteKey ?? ''}
            action="queue"
            className="flex flex-col items-center"
            onUnavailable={() => {
              if (captchaTriedBlindRef.current) return;
              captchaTriedBlindRef.current = true;
              void join();
            }}
            onToken={(token) => {
              if (!token) return;
              captchaTriedBlindRef.current = false;
              captchaTokenRef.current = token;
              generationRef.current += 1;
              networkFailsRef.current = 0;
              clearTimers();
              setState({ status: 'CHECKING' });
              startSlowWatch();
              void join();
            }}
          />
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
            {state.reason === 'network' ? 'Sin conexión con la cola' : state.reason === 'limit' ? 'Demasiados turnos desde esta conexión' : 'La cola está tardando'}
          </h1>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {state.reason === 'network'
              ? 'No hemos podido contactar con el servidor. Revisa la red e inténtalo de nuevo — tu sitio se conserva en este dispositivo si ya tenías turno.'
              : state.reason === 'limit'
                ? state.message ?? 'Ya hay demasiados turnos abiertos para este evento desde esta conexión. Espera a que alguno termine e inténtalo de nuevo.'
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

          <div className="relative brand-sticker text-sm text-lima-text mx-auto">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lima-text opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-lima-text" />
            </span>
            En cola
          </div>

          <div className="relative space-y-1" aria-live="polite">
            <p className="font-display font-semibold text-xs uppercase tracking-wide text-muted-foreground">
              Tu número
            </p>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p
                key={state.position}
                initial={{ opacity: 0, y: reduceMotion ? 0 : 10, scale: reduceMotion ? 1 : 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: reduceMotion ? 0 : -10, scale: reduceMotion ? 1 : 0.92 }}
                transition={{ duration: 0.3, ease: EASE_OUT }}
                className="font-display text-7xl md:text-8xl font-bold leading-none tracking-tight text-primary"
              >
                {state.position}
              </motion.p>
            </AnimatePresence>
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

          {busy && <BusyNotice />}

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
            Se acabó el tiempo para completar la compra. Puedes volver a la cola. Si llegaste a pagar, te llegará la confirmación por correo; si no, no se ha cobrado nada.
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
      <div className="brand-sticker text-sm text-lima-text" role="status" aria-live="polite">
        <Ticket className="h-3.5 w-3.5" /> Es tu turno — completa la compra
      </div>
      {state.expiresAt && (
        <AdmittedCountdown
          expiresAt={state.expiresAt}
          remainingMs={state.remainingMs}
          receivedAt={state.receivedAt}
          submittingRef={submittingRef}
          onExpire={() => setState({ status: 'EXPIRED' })}
        />
      )}
      <BuyTicketsForm event={event} queueToken={state.token} onSubmittingChange={onSubmittingChange} />
    </div>
  );
}

// Aviso mientras el servidor contesta «ocupado» (429/5xx): se reintenta solo, no es un fallo de la conexión del comprador.
function BusyNotice() {
  return (
    <p className="relative text-sm text-muted-foreground max-w-sm mx-auto" role="status">
      Hay mucha gente entrando ahora mismo. Seguimos intentándolo solos; no pierdes tu sitio.
    </p>
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

function AdmittedCountdown({
  expiresAt,
  remainingMs: serverRemainingMs,
  receivedAt,
  submittingRef,
  onExpire,
}: {
  expiresAt: string;
  remainingMs?: number;
  receivedAt: number;
  submittingRef: { current: boolean };
  onExpire: () => void;
}) {
  // El tiempo restante sale del reloj del servidor (H-091); el del dispositivo solo cuenta lo que pasa desde que llegó la respuesta.
  const compute = () => remainingFrom({ remainingMs: serverRemainingMs, expiresAt }, receivedAt, performance.now(), Date.now());
  const [remainingMs, setRemainingMs] = useState(compute);
  // Aviso para lectores de pantalla SOLO al cruzar 60 s y 10 s (H-092): un `aria-live="assertive"` en el temporizador recitaba cada segundo durante un minuto.
  const [announcement, setAnnouncement] = useState('');
  const previousSecondsRef = useRef(Math.ceil(compute() / 1000));

  useEffect(() => {
    const i = setInterval(() => {
      const remaining = compute();
      setRemainingMs(remaining);
      const seconds = Math.max(0, Math.ceil(remaining / 1000));
      const message = countdownAnnouncement(previousSecondsRef.current, seconds);
      previousSecondsRef.current = seconds;
      if (message) {
        setAnnouncement(message);
        // Aviso visible al llegar al último minuto: antes el formulario desaparecía a los 0 s sin más aviso que el rojo del contador (H-091).
        if (seconds > 10) toast.warning('Te queda 1 minuto para completar la compra.');
      }
      // Con un envío en curso no se desmonta el formulario a mitad de la compra: se espera a que termine (el servidor decide si el turno aún valía).
      if (remaining <= 0 && !submittingRef.current) onExpire();
    }, 1000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt, serverRemainingMs, receivedAt]);

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const low = totalSeconds <= 60;

  return (
    <div>
      <p className={cn('text-xs font-mono transition-colors duration-300', low ? 'text-destructive-text' : 'text-muted-foreground')} role="timer" aria-live="off">
        {remainingMs <= 0 && submittingRef.current
          ? 'Terminando tu compra…'
          : `Te quedan ${minutes}:${String(seconds).padStart(2, '0')} para completar la compra`}
      </p>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
