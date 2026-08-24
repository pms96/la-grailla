'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle,
  Download,
  Loader2,
  Calendar,
  MapPin,
  Ticket,
  Mail,
  Wallet,
  Clock,
  ArrowLeft,
  SearchX,
} from 'lucide-react';
import { FadeIn } from '@/components/ui/animate';

type OrderWithTickets = Prisma.OrderGetPayload<{
  include: { event: true; tickets: { include: { ticketType: true } } };
}>;

type OrderState = OrderWithTickets | { error: string } | null;

const MAX_POLLS = 15;
const POLL_INTERVAL_MS = 3000;

export default function ConfirmationClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderState>(null);
  const [loading, setLoading] = useState(true);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [emailStatus, setEmailStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [wallet, setWallet] = useState<{ google: boolean; apple: boolean }>({ google: false, apple: false });
  const [pollCount, setPollCount] = useState(0);

  const orderError = order && 'error' in order ? order.error : null;
  const validOrder = order && !('error' in order) ? order : null;
  const isPending = validOrder?.status === 'PENDING';

  const fetchOrder = () => {
    if (!orderId) return;
    setFetchFailed(false);
    fetch(`/api/orders/${orderId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('order_failed');
        return r.json();
      })
      .then((data) => setOrder(data))
      .catch(() => {
        setFetchFailed(true);
        setOrder(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchOrder();
    fetch('/api/wallet/status')
      .then((r) => r.json())
      .then((data) => setWallet({ google: Boolean(data?.google), apple: Boolean(data?.apple) }))
      .catch(() => {});
  }, [orderId]);

  // La pasarela confirma el pago de forma asíncrona: si volvemos aquí y el
  // pedido sigue PENDING, reintentamos la verificación cada pocos segundos
  // en vez de mostrar "confirmado" antes de que el pago se haya validado.
  useEffect(() => {
    if (!isPending || pollCount >= MAX_POLLS) return;
    const t = setTimeout(() => {
      setPollCount((c) => c + 1);
      fetchOrder();
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [isPending, pollCount, orderId]);

  useEffect(() => {
    if (!validOrder?.id || orderError || isPending) return;
    if (validOrder?.emailSentAt) {
      setEmailStatus('sent');
      return;
    }
    setEmailStatus('sending');
    fetch(`/api/orders/${validOrder.id}/send-tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((data) => setEmailStatus(data?.success ? 'sent' : 'error'))
      .catch(() => setEmailStatus('error'));
  }, [validOrder?.id, validOrder?.emailSentAt, orderError, isPending]);

  const resendEmail = async () => {
    setEmailStatus('sending');
    try {
      const res = await fetch(`/api/orders/${orderId}/send-tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      setEmailStatus(data?.success ? 'sent' : 'error');
    } catch {
      setEmailStatus('error');
    }
  };

  if (loading) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 py-20 text-center"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
        <p className="font-display font-semibold">Cargando tu pedido…</p>
        <p className="text-sm text-muted-foreground max-w-sm">Un momento mientras recuperamos la confirmación.</p>
      </div>
    );
  }

  if (!validOrder) {
    return (
      <FadeIn>
        <div className="text-center py-20 space-y-5 max-w-md mx-auto" role="alert">
          <SearchX className="h-12 w-12 text-muted-foreground mx-auto" aria-hidden />
          <div className="space-y-2">
            <h1 className="font-display text-2xl font-bold tracking-tight">
              {fetchFailed ? 'No hemos podido cargar el pedido' : 'Pedido no encontrado'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {fetchFailed
                ? 'Fallo de conexión o del servidor. Reintenta — si ya pagaste, el cobro no se duplica y el QR llegará por email.'
                : (
                  <>
                    Puede que el enlace haya caducado o que el pago no se haya completado. Si ya pagaste, revisa el email
                    del QR o escribe a{' '}
                    <a href="mailto:grupolagrailla@gmail.com" className="text-primary underline-offset-2 hover:underline">
                      grupolagrailla@gmail.com
                    </a>
                    .
                  </>
                )}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            {fetchFailed && (
              <Button
                className="gap-2"
                onClick={() => {
                  setLoading(true);
                  fetchOrder();
                }}
              >
                Reintentar
              </Button>
            )}
            <Button asChild variant={fetchFailed ? 'outline' : 'default'} className="gap-2">
              <Link href="/eventos">
                <Ticket className="h-4 w-4" /> Ver eventos
              </Link>
            </Button>
            <Button variant="outline" asChild className="gap-2">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" /> Ir al inicio
              </Link>
            </Button>
          </div>
        </div>
      </FadeIn>
    );
  }

  if (isPending) {
    const stillPolling = pollCount < MAX_POLLS;
    return (
      <FadeIn>
        <div className="text-center py-20 space-y-4" role="status" aria-live="polite">
          <Clock className="h-16 w-16 text-primary mx-auto animate-pulse" aria-hidden />
          <h1 className="font-display text-2xl font-bold tracking-tight">Confirmando tu pago…</h1>
          <p className="text-muted-foreground max-w-sm mx-auto">
            {stillPolling
              ? 'Estamos esperando la confirmación de la pasarela. Esta página se actualiza sola — no se cobrará dos veces.'
              : 'La confirmación tarda más de lo normal. Si completaste el pago, recibirás el QR por email cuando se confirme. Puedes cerrar esta página.'}
          </p>
          {!stillPolling && (
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <Button variant="outline" asChild className="gap-2">
                <Link href="/eventos">
                  <Ticket className="h-4 w-4" /> Ver eventos
                </Link>
              </Button>
              <Button variant="ghost" asChild className="gap-2">
                <a href="mailto:grupolagrailla@gmail.com">
                  <Mail className="h-4 w-4" /> Contactar
                </a>
              </Button>
            </div>
          )}
        </div>
      </FadeIn>
    );
  }

  const dateStr = validOrder?.event?.date
    ? new Date(validOrder.event.date).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  return (
    <FadeIn>
      <div className="space-y-6">
        <ConfirmationPeak />

        <Card>
          <CardContent className="p-6">
            <h2 className="font-display font-bold text-lg mb-4">{validOrder?.event?.name ?? ''}</h2>
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> {dateStr}</span>
              <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> {validOrder?.event?.venue ?? ''}, {validOrder?.event?.city ?? ''}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <Mail className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                <div>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.p
                      key={emailStatus}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className="font-medium leading-tight"
                    >
                      {emailStatus === 'sending' && 'Enviando tus entradas por email...'}
                      {emailStatus === 'sent' && 'Entradas enviadas por email'}
                      {emailStatus === 'error' && 'No hemos podido enviar el email'}
                      {emailStatus === 'idle' && 'Preparando el envío por email'}
                    </motion.p>
                  </AnimatePresence>
                  <p className="text-sm text-muted-foreground">
                    {emailStatus === 'error'
                      ? 'Puedes descargar el PDF aquí mismo o volver a intentarlo.'
                      : `Enviamos tus entradas a ${validOrder?.buyerEmail ?? ''}`}
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={resendEmail} disabled={emailStatus === 'sending'} className="gap-2 shrink-0">
                {emailStatus === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                Reenviar email
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <h3 className="font-display font-bold text-lg mb-4 flex items-center gap-2">
              <Ticket className="h-5 w-5 text-primary" /> Tus Entradas ({(validOrder?.tickets?.length ?? 0)})
            </h3>
            <div className="space-y-3">
              {(validOrder?.tickets ?? []).map((ticket) => (
                <div key={ticket?.id} className="p-3 rounded-lg bg-muted/50 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{ticket?.holderName ?? ''}</p>
                      <p className="text-xs text-muted-foreground">{ticket?.ticketType?.name ?? 'General'}</p>
                    </div>
                    <Badge variant="secondary" className="font-mono text-xs">{ticket?.qrCode?.slice(0, 12) ?? ''}</Badge>
                  </div>
                  {(wallet.google || wallet.apple) && (
                    <div className="flex flex-wrap gap-2">
                      {wallet.google && (
                        <Button asChild variant="outline" size="sm" className="gap-2">
                          <a href={`/api/wallet/google/${ticket?.id}`} target="_blank" rel="noopener noreferrer">
                            <Wallet className="h-3.5 w-3.5" /> Google Wallet
                          </a>
                        </Button>
                      )}
                      {wallet.apple && (
                        <Button asChild variant="outline" size="sm" className="gap-2">
                          <a href={`/api/wallet/apple/${ticket?.id}`}>
                            <Wallet className="h-3.5 w-3.5" /> Apple Wallet
                          </a>
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total pagado</p>
                <p className="font-display text-2xl font-bold">{(validOrder?.totalAmount ?? 0).toFixed(2)}€</p>
              </div>
              <Button asChild className="gap-2">
                <a href={`/api/tickets/${orderId}/pdf-html`} target="_blank" rel="noopener noreferrer">
                  <Download className="h-4 w-4" />
                  Ver e Imprimir
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}

/** Pico emocional de la compra: un solo momento authored (peak-end). */
function ConfirmationPeak() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="text-center">
      <motion.div
        className="inline-flex mb-4"
        initial={reduceMotion ? false : { scale: 0.6, opacity: 0, filter: 'blur(6px)' }}
        animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { type: 'spring', stiffness: 380, damping: 18, mass: 0.7 }
        }
      >
        <CheckCircle className="h-16 w-16 text-lima" aria-hidden />
      </motion.div>
      <motion.h1
        className="font-display text-2xl md:text-3xl font-bold tracking-tight"
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reduceMotion ? 0 : 0.12, duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
      >
        Compra confirmada
      </motion.h1>
      <motion.p
        className="text-muted-foreground mt-2"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reduceMotion ? 0 : 0.22, duration: 0.3 }}
      >
        Tus entradas están listas — QR por email
      </motion.p>
    </div>
  );
}
