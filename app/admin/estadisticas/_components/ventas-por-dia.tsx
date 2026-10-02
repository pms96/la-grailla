'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonPulse } from '@/components/ui/animate';
import { addDays, madridDayKey } from '@/lib/ventas-por-dia';

type Bucket = { importe: number; entradas: number; pedidos: number };
type Dia = {
  fecha: string;
  online: Bucket;
  taquillaTarjeta: Bucket;
  taquillaEfectivo: Bucket;
  gratis: Bucket;
  total: Bucket;
  cajaEntradas: number | null;
  diferenciaCaja: number | null;
};
type Respuesta = { dias: Dia[]; totales: Dia; cajaComparable: boolean };

const COLUMNAS = [
  { key: 'online', label: 'Online' },
  { key: 'taquillaTarjeta', label: 'Taquilla · tarjeta' },
  { key: 'taquillaEfectivo', label: 'Taquilla · efectivo' },
  { key: 'gratis', label: 'Invitaciones / gratis' },
] as const;

const eur = (n: number) => `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€`;

function formatDia(fecha: string) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-ES', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' });
}

function Celda({ bucket, mostrarImporte = true }: { bucket: Bucket; mostrarImporte?: boolean }) {
  if (bucket.pedidos === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="leading-tight">
      {mostrarImporte && <div className="font-medium">{eur(bucket.importe)}</div>}
      <div className="text-xs text-muted-foreground">{bucket.entradas} ent.</div>
    </div>
  );
}

function Diferencia({ valor }: { valor: number | null }) {
  if (valor === null) return <span className="text-muted-foreground">Sin caja</span>;
  if (valor === 0) return <span className="font-medium text-lima">Cuadra</span>;
  return <span className={`font-medium ${valor > 0 ? 'text-warm-yellow' : 'text-red-400'}`}>{valor > 0 ? '+' : ''}{eur(valor)}</span>;
}

export default function VentasPorDia({ eventId }: { eventId: string }) {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [data, setData] = useState<Respuesta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    if (desde) params.set('from', desde);
    if (hasta) params.set('to', hasta);
    if (eventId !== 'all') params.set('eventId', eventId);
    fetch(`/api/admin/stats/ventas-por-dia?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [desde, hasta, eventId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const atajos = useMemo(() => {
    const hoy = madridDayKey(new Date());
    return [
      { label: 'Hoy', desde: hoy, hasta: hoy },
      { label: 'Ayer', desde: addDays(hoy, -1), hasta: addDays(hoy, -1) },
      { label: 'Últimos 7 días', desde: addDays(hoy, -6), hasta: hoy },
      { label: 'Todo', desde: '', hasta: '' },
    ];
  }, []);

  const dias = data?.dias ?? [];
  const totales = data?.totales;
  const mostrarCaja = data?.cajaComparable ?? false;

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display font-bold text-lg">Ventas por día y canal</h2>
            <p className="text-sm text-muted-foreground">Qué se ha vendido cada día: online, taquilla con tarjeta y taquilla en efectivo.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground">
              Desde
              <Input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} className="mt-1 w-[150px]" />
            </label>
            <label className="text-xs text-muted-foreground">
              Hasta
              <Input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} className="mt-1 w-[150px]" />
            </label>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {atajos.map((a) => {
            const activo = desde === a.desde && hasta === a.hasta;
            return (
              <Button
                key={a.label}
                size="sm"
                variant={activo ? 'default' : 'outline'}
                onClick={() => { setDesde(a.desde); setHasta(a.hasta); }}
              >
                {a.label}
              </Button>
            );
          })}
        </div>

        {loading ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => <SkeletonPulse key={i} className="h-20 w-full rounded-lg" />)}
            </div>
            <SkeletonPulse className="h-48 w-full rounded-lg" />
          </div>
        ) : error ? (
          <p className="text-sm text-red-400">No se han podido cargar las ventas. Recarga la página para reintentarlo.</p>
        ) : dias.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Sin ventas en el periodo seleccionado.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {COLUMNAS.map((c) => (
                <div key={c.key} className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">{c.label}</p>
                  {c.key === 'gratis' ? (
                    <p className="font-display text-xl font-bold">{totales?.[c.key].entradas ?? 0} <span className="text-sm font-normal text-muted-foreground">entradas</span></p>
                  ) : (
                    <>
                      <p className="font-display text-xl font-bold">{eur(totales?.[c.key].importe ?? 0)}</p>
                      <p className="text-xs text-muted-foreground">{totales?.[c.key].entradas ?? 0} entradas</p>
                    </>
                  )}
                </div>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2 pr-4 font-medium">Día</th>
                    {COLUMNAS.map((c) => <th key={c.key} className="pb-2 pr-4 font-medium whitespace-nowrap">{c.label}</th>)}
                    <th className="pb-2 pr-4 font-medium">Total</th>
                    {mostrarCaja && <th className="pb-2 pr-4 font-medium whitespace-nowrap">Caja (Ingresos)</th>}
                    {mostrarCaja && <th className="pb-2 font-medium whitespace-nowrap">Caja − efectivo</th>}
                  </tr>
                </thead>
                <tbody className="[font-variant-numeric:tabular-nums]">
                  {dias.map((d) => (
                    <tr key={d.fecha} className="border-b border-border/40 align-top">
                      <td className="py-2 pr-4 whitespace-nowrap font-medium capitalize">{formatDia(d.fecha)}</td>
                      {COLUMNAS.map((c) => (
                        <td key={c.key} className="py-2 pr-4"><Celda bucket={d[c.key]} mostrarImporte={c.key !== 'gratis'} /></td>
                      ))}
                      <td className="py-2 pr-4"><Celda bucket={d.total} /></td>
                      {mostrarCaja && <td className="py-2 pr-4">{d.cajaEntradas === null ? <span className="text-muted-foreground">—</span> : eur(d.cajaEntradas)}</td>}
                      {mostrarCaja && <td className="py-2"><Diferencia valor={d.diferenciaCaja} /></td>}
                    </tr>
                  ))}
                </tbody>
                {totales && (
                  <tfoot className="[font-variant-numeric:tabular-nums]">
                    <tr className="border-t border-border align-top font-medium">
                      <td className="py-2 pr-4">Total</td>
                      {COLUMNAS.map((c) => (
                        <td key={c.key} className="py-2 pr-4"><Celda bucket={totales[c.key]} mostrarImporte={c.key !== 'gratis'} /></td>
                      ))}
                      <td className="py-2 pr-4"><Celda bucket={totales.total} /></td>
                      {mostrarCaja && <td className="py-2 pr-4">{totales.cajaEntradas === null ? <span className="text-muted-foreground">—</span> : eur(totales.cajaEntradas)}</td>}
                      {mostrarCaja && <td className="py-2"><Diferencia valor={totales.diferenciaCaja} /></td>}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {mostrarCaja ? (
              <p className="text-xs text-muted-foreground">
                «Caja» es lo que registras como concepto «Entradas» en Ingresos ese día. La diferencia solo se calcula en los días con caja registrada.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">La comparación con la caja se oculta al filtrar por evento: la caja de Ingresos no se registra por evento.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
