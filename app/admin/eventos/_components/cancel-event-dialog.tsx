'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, TriangleAlert, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/* Cancelar un evento con compradores (P1-04): vista previa de lo que pasará (pedidos, dinero), opciones (reembolsar, avisar), confirmación escrita y
 * seguimiento del trabajo. El trabajo es reanudable y lo continúa el cron aunque se cierre esta ventana; mientras está abierta, la propia ventana
 * pide el siguiente lote hasta terminar. La lógica vive en lib/event-cancellation.ts. */

type Preview = {
  refundable: { count: number; amount: number };
  withUsedTickets: number;
  manualOrGratis: { count: number; amount: number };
  pending: number;
  notifiable: number;
};
type Progress = {
  job: { refund: boolean; notify: boolean; startedAt: string; doneAt: string | null };
  done: boolean;
  refunded: number;
  refundsRemaining: number;
  pendingToCancel: number;
  emailsSent: number;
  emailsRemaining: number;
  emailsFailed: number;
  retryAt: string | null;
  manual: { orderId: string; reason: string }[];
};

const euros = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;
const CONFIRM_WORD = 'CANCELAR';

export function CancelEventDialog({ event, onClose, onChanged }: { event: { id: string; name: string; status: string } | null; onClose: () => void; onChanged: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [refund, setRefund] = useState(true);
  const [notify, setNotify] = useState(true);
  const [typed, setTyped] = useState('');
  const alive = useRef(true);
  const eventId = event?.id ?? null;
  // El evento que la ventana tiene abierto AHORA: el bucle de sondeo se corta en cuanto cambia o se cierra (la ventana está siempre montada).
  const eventIdRef = useRef<string | null>(eventId);
  eventIdRef.current = eventId;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/events/${id}/cancel`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'No se pudo cargar');
      if (!alive.current) return;
      setPreview(data.preview);
      setProgress(data.progress ?? null);
      setRefund(data.preview.refundable.count > 0);
      setNotify(data.preview.notifiable > 0);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo cargar la información del evento');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPreview(null);
    setProgress(null);
    setRunning(false);
    setTyped('');
    if (eventId) void load(eventId);
  }, [eventId, load]);

  /** Pide lotes hasta que el trabajo termina o se cierra la ventana (el cron sigue por su cuenta). */
  const drive = useCallback(
    async (id: string, first: Promise<Response>) => {
      setRunning(true);
      try {
        let res = await first;
        for (;;) {
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error ?? 'Error al procesar la cancelación');
          if (!alive.current || eventIdRef.current !== id) return;
          setProgress(data.progress);
          if (!data.progress || data.progress.done) break;
          // Hay reintentos esperando su turno (un reembolso o un email que falló): no se insiste cada segundo, lo sigue el cron.
          if (data.progress.retryAt && new Date(data.progress.retryAt).getTime() > Date.now()) break;
          await new Promise((r) => setTimeout(r, 1000));
          if (!alive.current || eventIdRef.current !== id) return;
          res = await fetch(`/api/admin/events/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'continue' }) });
        }
        onChanged();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Error al procesar la cancelación');
      } finally {
        if (alive.current && eventIdRef.current === id) setRunning(false);
      }
    },
    [onChanged]
  );

  const start = () => {
    if (!eventId) return;
    void drive(eventId, fetch(`/api/admin/events/${eventId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', refund, notify }) }));
  };
  const resume = () => {
    if (!eventId) return;
    void drive(eventId, fetch(`/api/admin/events/${eventId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'continue' }) }));
  };

  const started = progress !== null;
  const canStart = !started && !running && typed.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{started ? `Cancelación de «${event?.name}»` : `Cancelar «${event?.name}»`}</DialogTitle>
          <DialogDescription>
            {started ? 'El evento está cancelado: la venta y el escáner ya están cerrados.' : 'Se cierra la venta y el escáner al instante. Esta acción no se puede deshacer.'}
          </DialogDescription>
        </DialogHeader>

        {loading || !preview ? (
          <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Cargando pedidos…</div>
        ) : !started ? (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border p-3 space-y-1.5">
              <p className="font-medium">Qué pasará con los pedidos</p>
              <ul className="space-y-1 text-muted-foreground">
                <li><span className="text-foreground tabular-nums font-medium">{preview.refundable.count}</span> pedidos pagados con tarjeta ({euros(preview.refundable.amount)}) se pueden reembolsar automáticamente.</li>
                <li><span className="text-foreground tabular-nums font-medium">{preview.manualOrGratis.count}</span> pedidos más ({euros(preview.manualOrGratis.amount)}) son en efectivo, gratuitos, invitaciones o tienen entradas ya usadas: no se reembolsan solos.</li>
                <li><span className="text-foreground tabular-nums font-medium">{preview.pending}</span> pedidos sin pagar se anulan y su sesión de pago se cierra.</li>
              </ul>
            </div>
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <Checkbox id="cancel-refund" checked={refund} onCheckedChange={(v) => setRefund(v === true)} disabled={preview.refundable.count === 0} className="mt-0.5" />
                <Label htmlFor="cancel-refund" className="font-normal leading-snug">Reembolsar automáticamente los pagos con tarjeta. Si lo dejas sin marcar, los reembolsos los haces tú después, uno a uno.</Label>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox id="cancel-notify" checked={notify} onCheckedChange={(v) => setNotify(v === true)} disabled={preview.notifiable === 0} className="mt-0.5" />
                <Label htmlFor="cancel-notify" className="font-normal leading-snug">Avisar por email a los {preview.notifiable} compradores online (les dice si se les reembolsa o si lo gestionas tú).</Label>
              </div>
            </div>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex gap-2">
              <TriangleAlert className="h-4 w-4 text-destructive-text shrink-0 mt-0.5" aria-hidden />
              <p>Los reembolsos devuelven el dinero a los compradores y no se pueden deshacer. Si el correo no funciona, los compradores no recibirán el aviso: comprueba el SMTP en Configuración antes de empezar.</p>
            </div>
            <div>
              <Label htmlFor="cancel-confirm">Para confirmar, escribe <span className="font-mono font-semibold">{CONFIRM_WORD}</span></Label>
              <Input id="cancel-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1" autoComplete="off" />
            </div>
          </div>
        ) : (
          <ProgressView progress={progress!} running={running} />
        )}

        <DialogFooter className="gap-2">
          {!started ? (
            <>
              <Button variant="outline" onClick={onClose}>Volver</Button>
              <Button variant="destructive" onClick={start} disabled={!canStart || loading || !preview}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Cancelar el evento
              </Button>
            </>
          ) : (
            <>
              {!progress!.done && !running && <Button onClick={resume}>Continuar ahora</Button>}
              <Button variant="outline" onClick={onClose}>{progress!.done ? 'Cerrar' : 'Cerrar (sigue en segundo plano)'}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProgressView({ progress, running }: { progress: Progress; running: boolean }) {
  const { job } = progress;
  return (
    <div className="space-y-3 text-sm" aria-live="polite">
      <div className="flex items-center gap-2 font-medium">
        {progress.done ? <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden /> : <Loader2 className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} aria-hidden />}
        {progress.done ? 'Terminado' : running ? 'Procesando…' : progress.retryAt ? `Reintentando a las ${new Date(progress.retryAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}: sigue solo` : 'En marcha: sigue solo cada pocos minutos'}
      </div>
      <ul className="space-y-1 text-muted-foreground">
        {job.refund && (
          <li><span className="text-foreground tabular-nums font-medium">{progress.refunded}</span> reembolsados · faltan <span className="text-foreground tabular-nums font-medium">{progress.refundsRemaining}</span></li>
        )}
        {progress.pendingToCancel > 0 && <li>{progress.pendingToCancel} pedidos sin pagar por anular</li>}
        {job.notify && (
          <li>
            <span className="text-foreground tabular-nums font-medium">{progress.emailsSent}</span> avisos enviados · faltan <span className="text-foreground tabular-nums font-medium">{progress.emailsRemaining}</span>
            {progress.emailsFailed > 0 && <span className="text-destructive-text"> · {progress.emailsFailed} sin enviar (revisa el SMTP)</span>}
          </li>
        )}
      </ul>
      {progress.manual.length > 0 && (
        <div className="rounded-lg border border-warm-yellow/40 bg-warm-yellow/5 p-3">
          <p className="font-medium mb-1">A resolver a mano ({progress.manual.length})</p>
          <ul className="space-y-1 text-xs text-muted-foreground max-h-40 overflow-y-auto">
            {progress.manual.map((m) => (
              <li key={m.orderId}><span className="font-mono">{m.orderId.slice(0, 8)}</span> — {m.reason}. Ábrelo en Ventas para reembolsarlo desde allí.</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
