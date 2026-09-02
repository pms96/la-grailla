'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Temporada } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableFooter } from '@/components/ui/table';
import { Loader2, ClipboardList } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type PrecioFila = { proveedorId: string; proveedorNombre: string; precioSinIva: number; precioConIva: number; formatoVenta: string; unidadMinPedido: number };

type Fila = {
  articuloId: string;
  nombre: string;
  categoria: string;
  formato: string;
  precios: PrecioFila[];
  recomendado: { proveedorId: string; proveedorNombre: string; precioConIva: number } | null;
  ahorroUnidad: number;
  consumoReferencia: { temporadaNombre: string; cantidadNeta: number } | null;
  proveedorElegidoId: string | null;
  cantidadPlanificada: number;
  observaciones: string;
  costeTotalEstimado: number;
};

function AhorroBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="w-20">
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full', clamped > 0 ? 'bg-[hsl(var(--chart-2))]' : 'bg-transparent')} style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{clamped.toFixed(0)}%</span>
    </div>
  );
}

export function TabPlanificador({ temporada }: { temporada: Temporada | null }) {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [temporadaAnterior, setTemporadaAnterior] = useState<Temporada | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPlanificador = useCallback(() => {
    if (!temporada) { setFilas([]); setLoading(false); return; }
    setLoading(true);
    fetch(`/api/admin/compras/planificador?temporadaId=${temporada.id}`)
      .then((r) => r.json())
      .then((d) => {
        setFilas(Array.isArray(d?.filas) ? d.filas : []);
        setTemporadaAnterior(d?.temporadaAnterior ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [temporada]);

  useEffect(() => { fetchPlanificador(); }, [fetchPlanificador]);

  const guardarPlan = async (articuloId: string, patch: { proveedorElegidoId?: string | null; cantidadPlanificada?: number; observaciones?: string }) => {
    if (!temporada) return;
    try {
      const res = await fetch(`/api/admin/compras/plan/${articuloId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ temporadaId: temporada.id, ...patch }),
      });
      if (!res.ok) { toast.error('No se pudo guardar la planificación'); return; }
      fetchPlanificador();
    } catch {
      toast.error('Error de conexión');
    }
  };

  const updateLocal = (articuloId: string, patch: Partial<Fila>) => {
    setFilas((prev) => prev.map((f) => {
      if (f.articuloId !== articuloId) return f;
      const next = { ...f, ...patch };
      const precioElegido = next.precios.find((p) => p.proveedorId === next.proveedorElegidoId);
      next.costeTotalEstimado = precioElegido ? Math.round(precioElegido.precioConIva * next.cantidadPlanificada * 100) / 100 : 0;
      return next;
    }));
  };

  if (!temporada) {
    return <p className="text-sm text-muted-foreground py-10 text-center">Selecciona o crea una temporada para planificar sus compras.</p>;
  }
  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  if (filas.length === 0) {
    return (
      <Card><CardContent className="p-10 text-center text-muted-foreground">
        <ClipboardList className="h-8 w-8 mx-auto mb-3 opacity-50" />
        Da de alta artículos en la pestaña Artículos para poder planificar esta temporada.
      </CardContent></Card>
    );
  }

  const totalPlanificado = filas.reduce((sum, f) => sum + f.costeTotalEstimado, 0);
  const totalUnidades = filas.reduce((sum, f) => sum + f.cantidadPlanificada, 0);

  return (
    <div className="space-y-3">
      {temporadaAnterior && (
        <p className="text-xs text-muted-foreground">Consumo de referencia: {temporadaAnterior.nombre}</p>
      )}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px]">Artículo</TableHead>
                  <TableHead>Precios (c/IVA)</TableHead>
                  <TableHead>Ahorro</TableHead>
                  <TableHead>Consumo ref.</TableHead>
                  <TableHead className="min-w-[160px]">Proveedor elegido</TableHead>
                  <TableHead className="w-28">Cantidad 2026</TableHead>
                  <TableHead className="w-28">Coste estimado</TableHead>
                  <TableHead className="min-w-[160px]">Observaciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filas.map((f) => {
                  const mejorPrecioConIva = f.precios.length ? Math.max(...f.precios.map((p) => p.precioConIva)) : 0;
                  const precioElegido = f.precios.find((p) => p.proveedorId === f.proveedorElegidoId);
                  const pctAhorro = precioElegido && mejorPrecioConIva > 0
                    ? ((mejorPrecioConIva - precioElegido.precioConIva) / mejorPrecioConIva) * 100
                    : 0;
                  return (
                    <TableRow key={f.articuloId}>
                      <TableCell>
                        <p className="font-medium leading-tight">{f.nombre}</p>
                        <p className="text-xs text-muted-foreground">{f.categoria} · {f.formato}</p>
                      </TableCell>
                      <TableCell>
                        {f.precios.length === 0 ? (
                          <Badge variant="destructive">Sin precio</Badge>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {f.precios.map((p) => (
                              <Badge key={p.proveedorId} variant={p.proveedorId === f.recomendado?.proveedorId ? 'default' : 'outline'} className="w-fit">
                                {p.proveedorNombre}: {p.precioConIva.toFixed(2)}€
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell><AhorroBar pct={pctAhorro} /></TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {f.consumoReferencia ? `${f.consumoReferencia.cantidadNeta} ud.` : '—'}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={f.proveedorElegidoId ?? ''}
                          onValueChange={(v) => { updateLocal(f.articuloId, { proveedorElegidoId: v }); guardarPlan(f.articuloId, { proveedorElegidoId: v }); }}
                          disabled={f.precios.length === 0}
                        >
                          <SelectTrigger className="h-8"><SelectValue placeholder="—" /></SelectTrigger>
                          <SelectContent>
                            {f.precios.map((p) => <SelectItem key={p.proveedorId} value={p.proveedorId}>{p.proveedorNombre}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number" min={0} className="h-8 w-24"
                          value={f.cantidadPlanificada}
                          onChange={(e) => updateLocal(f.articuloId, { cantidadPlanificada: Number(e.target.value) || 0 })}
                          onBlur={(e) => guardarPlan(f.articuloId, { cantidadPlanificada: Number(e.target.value) || 0 })}
                        />
                      </TableCell>
                      <TableCell className="font-medium whitespace-nowrap">{f.costeTotalEstimado.toFixed(2)}€</TableCell>
                      <TableCell>
                        <Input
                          className="h-8 min-w-[160px]"
                          defaultValue={f.observaciones}
                          onBlur={(e) => { if (e.target.value !== f.observaciones) guardarPlan(f.articuloId, { observaciones: e.target.value }); }}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow className="sticky bottom-0 bg-background">
                  <TableCell colSpan={5} className="text-right font-semibold">Totales</TableCell>
                  <TableCell className="font-semibold">{totalUnidades} ud.</TableCell>
                  <TableCell className="font-semibold whitespace-nowrap">{totalPlanificado.toFixed(2)}€</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
