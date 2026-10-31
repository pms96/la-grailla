'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive, ArchiveRestore, ArrowLeft, Inbox, Loader2, Mail, Phone, Search, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/layouts/page-header';
import { ConfirmDeleteDialog } from '@/app/admin/_components/confirm-delete-dialog';
import { cn } from '@/lib/utils';

/* Bandeja de mensajes del formulario de contacto (núcleo). Lista a la izquierda, conversación a la derecha (en móvil, una u otra). */

type Status = 'NEW' | 'ANSWERED' | 'ARCHIVED';
type Row = { id: string; name: string; email: string; subject: string | null; message: string; status: Status; createdAt: string; replies: number };
type Reply = { id: string; body: string; sentBy: string | null; emailSent: boolean; emailError: string | null; createdAt: string };
type Detail = { id: string; name: string; email: string; phone: string | null; subject: string | null; message: string; status: Status; consentAt: string | null; createdAt: string; replies: Reply[] };
type Counts = Record<Status, number>;

const LABELS: Record<Status, string> = { NEW: 'Sin responder', ANSWERED: 'Respondido', ARCHIVED: 'Archivado' };
const VARIANTS = { NEW: 'default', ANSWERED: 'secondary', ARCHIVED: 'outline' } as const;
const TABS: { key: Status | 'ALL'; label: string }[] = [
  { key: 'NEW', label: 'Sin responder' },
  { key: 'ANSWERED', label: 'Respondidos' },
  { key: 'ARCHIVED', label: 'Archivados' },
  { key: 'ALL', label: 'Todos' },
];

const fmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
const fmtLong = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' });

export default function MensajesPage() {
  const [tab, setTab] = useState<Status | 'ALL'>('NEW');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Counts>({ NEW: 0, ANSWERED: 0, ARCHIVED: 0 });
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadList = useCallback(async () => {
    const params = new URLSearchParams();
    if (tab !== 'ALL') params.set('status', tab);
    if (q.trim()) params.set('q', q.trim());
    try {
      const res = await fetch(`/api/admin/contact?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRows(data.items);
      setCounts(data.counts);
    } catch {
      toast.error('No se han podido cargar los mensajes');
    } finally {
      setLoading(false);
    }
  }, [tab, q]);

  // Búsqueda con una pequeña espera para no pedir en cada tecla.
  useEffect(() => {
    const t = setTimeout(loadList, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadList, q]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/admin/contact/${id}`);
    if (!res.ok) return toast.error('No se ha podido abrir el mensaje');
    setDetail(await res.json());
  }, []);

  useEffect(() => {
    setReply('');
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const setStatus = async (status: Status) => {
    if (!detail) return;
    const res = await fetch(`/api/admin/contact/${detail.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    if (!res.ok) return toast.error('No se ha podido cambiar el estado');
    toast.success(status === 'ARCHIVED' ? 'Mensaje archivado' : 'Mensaje restaurado');
    await Promise.all([loadDetail(detail.id), loadList()]);
  };

  const send = async () => {
    if (!detail || !reply.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/admin/contact/${detail.id}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: reply }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? 'No se ha podido enviar la respuesta');
      } else {
        toast.success('Respuesta enviada');
        setReply('');
      }
      await Promise.all([loadDetail(detail.id), loadList()]);
    } catch {
      toast.error('Error de conexión al enviar');
    } finally {
      setSending(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    const res = await fetch(`/api/admin/contact/${detail.id}`, { method: 'DELETE' });
    if (!res.ok) return toast.error('No se ha podido eliminar');
    toast.success('Mensaje eliminado');
    setSelectedId(null);
    await loadList();
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Mensajes" description="Lo que te escriben desde el formulario de contacto de tu web." />

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Estado de los mensajes">
        {TABS.map((t) => (
          <Button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            variant={tab === t.key ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => { setTab(t.key); setSelectedId(null); }}
            className="gap-2"
          >
            {t.label}
            {t.key !== 'ALL' && <span className="font-mono text-xs text-muted-foreground">{counts[t.key]}</span>}
          </Button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" className="pl-9" aria-label="Buscar mensajes" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <ul className={cn('divide-y divide-border overflow-hidden rounded-lg border border-border', selectedId && 'hidden lg:block')} aria-label="Mensajes">
          {loading ? (
            <li className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></li>
          ) : rows.length === 0 ? (
            <li className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
              <Inbox className="h-8 w-8 text-muted-foreground/60" aria-hidden />
              {q ? 'Ningún mensaje coincide con la búsqueda.' : tab === 'NEW' ? 'No tienes mensajes por responder.' : 'No hay mensajes en esta lista.'}
            </li>
          ) : (
            rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  aria-current={selectedId === r.id}
                  className={cn('w-full px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none', selectedId === r.id && 'bg-muted')}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={cn('truncate text-sm', r.status === 'NEW' ? 'font-semibold' : 'font-medium')}>{r.name}</span>
                    <time className="shrink-0 font-mono text-xs text-muted-foreground" dateTime={r.createdAt}>{fmt.format(new Date(r.createdAt))}</time>
                  </div>
                  <p className="truncate text-sm">{r.subject || 'Sin asunto'}</p>
                  <p className="truncate text-xs text-muted-foreground">{r.message}</p>
                </button>
              </li>
            ))
          )}
        </ul>

        <section className={cn('min-w-0', !selectedId && 'hidden lg:block')} aria-live="polite">
          {!detail ? (
            <div className="flex h-full min-h-48 items-center justify-center rounded-lg border border-dashed border-border p-10 text-sm text-muted-foreground">
              {selectedId ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : 'Elige un mensaje para leerlo y responder.'}
            </div>
          ) : (
            <div className="space-y-5">
              <Button variant="ghost" size="sm" className="-ml-2 gap-2 lg:hidden" onClick={() => setSelectedId(null)}>
                <ArrowLeft className="h-4 w-4" /> Volver
              </Button>
              <header className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 className="font-display text-xl font-semibold tracking-tight">{detail.subject || 'Sin asunto'}</h2>
                  <StatusBadge status={detail.status} labels={LABELS} variants={VARIANTS} />
                </div>
                <p className="text-sm">
                  <span className="font-medium">{detail.name}</span>{' '}
                  <a className="text-primary underline-offset-2 hover:underline" href={`mailto:${detail.email}`}>{detail.email}</a>
                </p>
                <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <time dateTime={detail.createdAt}>{fmtLong.format(new Date(detail.createdAt))}</time>
                  {detail.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" aria-hidden />{detail.phone}</span>}
                  {detail.consentAt && <span>Aceptó la política de privacidad</span>}
                </p>
              </header>

              <div className="whitespace-pre-wrap rounded-lg border border-border bg-card p-4 text-sm leading-relaxed">{detail.message}</div>

              {detail.replies.length > 0 && (
                <ol className="space-y-3" aria-label="Respuestas enviadas">
                  {detail.replies.map((rp) => (
                    <li key={rp.id} className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                      <p className="mb-2 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" aria-hidden />{rp.sentBy ?? 'Tú'}</span>
                        <time dateTime={rp.createdAt}>{fmtLong.format(new Date(rp.createdAt))}</time>
                        {!rp.emailSent && <span className="font-semibold text-destructive-text">No enviada: {rp.emailError ?? 'error desconocido'}</span>}
                      </p>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{rp.body}</p>
                    </li>
                  ))}
                </ol>
              )}

              <div className="space-y-2">
                <label htmlFor="reply" className="text-sm font-medium">Responder a {detail.name}</label>
                <Textarea id="reply" rows={5} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={5000} placeholder="Escribe tu respuesta. Se enviará por email y quedará guardada aquí." />
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={send} disabled={sending || !reply.trim()} className="gap-2">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {sending ? 'Enviando…' : 'Enviar respuesta'}
                  </Button>
                  {detail.status === 'ARCHIVED' ? (
                    <Button variant="ghost" onClick={() => setStatus(detail.replies.some((r) => r.emailSent) ? 'ANSWERED' : 'NEW')} className="gap-2"><ArchiveRestore className="h-4 w-4" /> Restaurar</Button>
                  ) : (
                    <Button variant="ghost" onClick={() => setStatus('ARCHIVED')} className="gap-2"><Archive className="h-4 w-4" /> Archivar</Button>
                  )}
                  <Button variant="ghost" onClick={() => setConfirmDelete(true)} className="ml-auto gap-2 text-destructive-text hover:text-destructive-text"><Trash2 className="h-4 w-4" /> Eliminar</Button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      <ConfirmDeleteDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Eliminar mensaje"
        description={detail ? <>Se borrará definitivamente el mensaje de <strong>{detail.name}</strong> ({detail.email}) y sus respuestas. No se puede deshacer.</> : null}
        onConfirm={remove}
      />
    </div>
  );
}
