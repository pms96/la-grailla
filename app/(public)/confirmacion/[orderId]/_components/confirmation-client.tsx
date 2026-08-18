'use client';

import { useEffect, useState } from 'react';
import type { Prisma } from '@prisma/client';
import { AnimatePresence, motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, Download, Loader2, Calendar, MapPin, Ticket, Mail, Wallet, Clock } from 'lucide-react';
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
  const [emailStatus, setEmailStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [wallet, setWallet] = useState<{ google: boolean; apple: boolean }>({ google: false, apple: false });
  const [pollCount, setPollCount] = useState(0);

  const orderError = order && 'error' in order ? order.error : null;
  const validOrder = order && !('error' in order) ? order : null;
  const isPending = validOrder?.status === 'PENDING';

  const fetchOrder = () => {
    if (!orderId) return;
    fetch(`/api/orders/${orderId}`)
      .then((r) => r.json())
      .then((data) => setOrder(data))
      .catch(() => {})
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
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!validOrder) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">Pedido no encontrado</p>
      </div>
    );
  }

  if (isPending) {
    return (
      <FadeIn>
        <div className="text-center py-20 space-y-4">
          <Clock className="h-16 w-16 text-primary mx-auto animate-pulse" />
          <h1 className="font-display text-2xl font-bold tracking-tight">Confirmando tu pago...</h1>
          <p className="text-muted-foreground max-w-sm mx-auto">
            {pollCount < MAX_POLLS
              ? 'Estamos esperando la confirmación de la pasarela de pago. Esta página se actualizará sola.'
              : 'La confirmación está tardando más de lo normal. Si has completado el pago, recibirás tus entradas por email en cuanto se confirme — puedes cerrar esta página.'}
          </p>
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
        <div className="text-center">
          <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Compra Confirmada</h1>
          <p className="text-muted-foreground mt-2">Tus entradas están listas</p>
        </div>

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
