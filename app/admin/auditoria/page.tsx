'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layouts/page-header';
import { cn } from '@/lib/utils';

/* Registro de auditoría (P1-16): quién hizo qué, en dinero, cuentas y accesos. Solo lo ve el propietario (el middleware y la API lo comprueban).
 * Los reembolsos, las anulaciones de gastos e ingresos, los cierres de temporada, los cambios de pasarela, correo y claves, y los de usuarios y roles. */

type Row = { id: string; createdAt: string; actorEmail: string | null; action: string; targetType: string; targetId: string | null; meta: Record<string, unknown> | null; ip: string | null };

const ACTION_LABELS: Record<string, string> = {
  'gasto.create': 'Gasto creado',
  'gasto.update': 'Gasto modificado',
  'gasto.void': 'Gasto anulado',
  'ingreso.create': 'Ingreso creado',
  'ingreso.update': 'Ingreso modificado',
  'ingreso.void': 'Ingreso anulado',
  'temporada.close': 'Temporada cerrada',
  'temporada.reopen': 'Temporada reabierta',
  'temporada.update': 'Temporada modificada',
  'order.cancel': 'Pedido cancelado',
  'order.refund': 'Pedido reembolsado',
  'order.complete': 'Pedido marcado como pagado',
  'order.verify': 'Pago verificado en la pasarela',
  'order.update_email': 'Email de pedido cambiado',
  'order.shop_cancel': 'Pedido de tienda cancelado',
  'order.shop_refund': 'Pedido de tienda reembolsado',
  'event.cancel': 'Evento cancelado',
  'config.update': 'Configuración modificada',
  'user.create': 'Usuario creado',
  'user.update': 'Usuario modificado',
  'user.delete': 'Usuario eliminado',
  'role.create': 'Rol creado',
  'role.update': 'Rol modificado',
  'role.delete': 'Rol eliminado',
};

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'Todo' },
  { key: 'gasto', label: 'Gastos' },
  { key: 'ingreso', label: 'Ingresos' },
  { key: 'temporada', label: 'Temporadas' },
  { key: 'order', label: 'Pedidos' },
  { key: 'event', label: 'Eventos' },
  { key: 'config', label: 'Configuración' },
  { key: 'user', label: 'Usuarios' },
  { key: 'role', label: 'Roles' },
];

const fmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Resumen de una línea de lo que quedó anotado: el motivo si lo hay, los cambios de → a y los importes. */
function summarize(meta: Row['meta']): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (typeof meta.motivo === 'string') parts.push(`Motivo: ${meta.motivo}`);
  if (meta.concepto) parts.push(String(meta.concepto));
  if (meta.importeSinIva !== undefined) parts.push(`${show(meta.importeSinIva)} € + IVA ${show(meta.ivaPercent)} %`);
  else if (meta.importe !== undefined) parts.push(`${show(meta.importe)} €`);
  if (meta.totalAmount !== undefined) parts.push(`${show(meta.totalAmount)} €`);
  const cambios = (meta.cambios ?? meta.valores) as Record<string, { from: unknown; to: unknown }> | undefined;
  if (cambios && typeof cambios === 'object') {
    for (const [campo, c] of Object.entries(cambios)) parts.push(`${campo}: ${show(c?.from)} → ${show(c?.to)}`);
  }
  if (Array.isArray(meta.claves)) parts.push(`Claves: ${meta.claves.join(', ')}${Array.isArray(meta.sensibles) && meta.sensibles.length ? ' (con claves secretas; el valor no se guarda)' : ''}`);
  if (meta.contrasenaCambiada) parts.push('Contraseña cambiada');
  if (meta.email && typeof meta.email === 'string') parts.push(meta.email);
  return parts.join(' · ');
}

export default function AuditoriaPage() {
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams();
      if (filter) params.set('accion', filter);
      if (after) params.set('cursor', after);
      const res = await fetch(`/api/admin/auditoria?${params}`);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Error');
      return (await res.json()) as { items: Row[]; nextCursor: string | null };
    },
    [filter]
  );

  useEffect(() => {
    setLoading(true);
    load(null)
      .then((d) => {
        setRows(d.items);
        setCursor(d.nextCursor);
      })
      .catch((e: Error) => toast.error(e.message || 'No se ha podido cargar el registro'))
      .finally(() => setLoading(false));
  }, [load]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const d = await load(cursor);
      setRows((r) => [...r, ...d.items]);
      setCursor(d.nextCursor);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se han podido cargar más');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Auditoría" description="Quién hizo qué con el dinero, las cuentas y los accesos. Solo lo ves tú, como propietario." />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por tipo de acción">
        {FILTERS.map((f) => (
          <Button key={f.key || 'todo'} size="sm" variant={filter === f.key ? 'default' : 'outline'} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando el registro…
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-14 text-center text-sm text-muted-foreground">
          <ScrollText className="h-6 w-6" />
          Todavía no hay acciones registradas{filter ? ' de este tipo' : ''}.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
              <time dateTime={r.createdAt} className="text-xs text-muted-foreground tabular-nums sm:pt-0.5">
                {fmt.format(new Date(r.createdAt))}
              </time>
              <div className="min-w-0">
                <p className={cn('text-sm font-medium', /void|delete|cancel|refund/.test(r.action) && 'text-destructive-text')}>{ACTION_LABELS[r.action] ?? r.action}</p>
                <p className="break-words text-sm text-muted-foreground">{summarize(r.meta) || '—'}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.actorEmail ?? 'Sistema'}
                  {r.ip ? ` · ${r.ip}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {cursor && !loading && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={more} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Cargar más
          </Button>
        </div>
      )}
    </div>
  );
}
