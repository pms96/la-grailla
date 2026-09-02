'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Temporada, Pedido, Proveedor, LineaPedido, Articulo, Gasto } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Sparkles, PackageCheck, Send, Wallet, FileSpreadsheet, FileText, Info } from 'lucide-react';
import { toast } from 'sonner';
import { precioFinalUnidad } from '@/lib/compras/calculadora';
import { PEDIDO_STATUS_LABEL as STATUS_LABEL } from '@/lib/compras/constantes';
import { GastoDesdePedidoDialog } from '@/app/admin/gastos/_components/gasto-desde-pedido-dialog';
import { downloadPedidosExport } from '@/lib/compras/pedidos-export';

type PedidoConDetalle = Pedido & {
  proveedor: Proveedor;
  temporada: Temporada;
  lineas: (LineaPedido & { articulo: Articulo })[];
  gasto: Gasto | null;
};

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'default'> = { BORRADOR: 'secondary', ENVIADO: 'outline', RECIBIDO: 'default' };
const SIGUIENTE_ESTADO: Record<string, string> = { BORRADOR: 'ENVIADO', ENVIADO: 'RECIBIDO' };

export function TabPedidos({ temporada }: { temporada: Temporada | null }) {
  const [pedidos, setPedidos] = useState<PedidoConDetalle[]>([]);
  const [loading, setLoading] = useState(true);
  const [generando, setGenerando] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [registrarGastoPedido, setRegistrarGastoPedido] = useState<PedidoConDetalle | null>(null);
  const [exportando, setExportando] = useState<'excel' | 'pdf' | null>(null);
  const [incluirPrecios, setIncluirPrecios] = useState(true);

  const fetchPedidos = useCallback(() => {
    if (!temporada) { setPedidos([]); setLoading(false); return; }
    setLoading(true);
    fetch(`/api/admin/compras/pedidos?temporadaId=${temporada.id}`)
      .then((r) => r.json())
      .then((d) => setPedidos(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [temporada]);

  useEffect(() => { fetchPedidos(); }, [fetchPedidos]);

  const generarPedidos = async () => {
    if (!temporada) return;
    setGenerando(true);
    try {
      const res = await fetch('/api/admin/compras/pedidos/generar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ temporadaId: temporada.id }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data?.error ?? 'No se pudieron generar los pedidos'); return; }
      const nPedidos = data?.pedidos?.length ?? 0;
      const omitidos: { proveedorNombre: string; motivo: string }[] = data?.omitidos ?? [];
      toast.success(`${nPedidos} pedido(s) generado(s) o actualizado(s) con las cantidades del planificador`);
      omitidos.forEach((o) => toast.warning(`${o.proveedorNombre} ${o.motivo}`));
      fetchPedidos();
    } catch {
      toast.error('Error de conexión');
    } finally {
      setGenerando(false);
    }
  };

  const avanzarEstado = async (pedido: PedidoConDetalle) => {
    const siguiente = SIGUIENTE_ESTADO[pedido.status];
    if (!siguiente) return;
    try {
      const res = await fetch(`/api/admin/compras/pedidos/${pedido.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: siguiente }),
      });
      if (!res.ok) { toast.error('No se pudo actualizar el estado'); return; }
      toast.success(`Pedido marcado como ${STATUS_LABEL[siguiente].toLowerCase()}`);
      fetchPedidos();
    } catch {
      toast.error('Error de conexión');
    }
  };

  const handleExport = async (format: 'excel' | 'pdf') => {
    if (!temporada) return;
    setExportando(format);
    try {
      await downloadPedidosExport(temporada.id, format, incluirPrecios);
      toast.success(format === 'excel' ? 'Excel de pedidos descargado' : 'PDF de pedidos descargado');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al exportar');
    } finally {
      setExportando(null);
    }
  };

  if (!temporada) {
    return <p className="text-sm text-muted-foreground py-10 text-center">Selecciona una temporada para ver sus pedidos.</p>;
  }
  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;

  const selected = pedidos.find((p) => p.id === selectedId) ?? pedidos[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 shrink-0 mt-0.5" />
        <p>
          <strong>Generar pedidos</strong> agrupa, por proveedor, todos los artículos con cantidad planificada en la pestaña Planificador. Si un
          proveedor ya tiene un pedido en <strong>borrador</strong>, se actualiza con las cantidades actuales — puedes pulsarlo tantas veces como
          quieras mientras sigas ajustando el planificador. Un pedido ya <strong>enviado</strong> o <strong>recibido</strong> nunca se modifica ni se
          duplica.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground mr-1">
          <input type="checkbox" checked={incluirPrecios} onChange={(e) => setIncluirPrecios(e.target.checked)} className="h-3.5 w-3.5" />
          Incluir precios en la exportación
        </label>
        <Button variant="outline" size="sm" className="gap-2" disabled={exportando !== null || pedidos.length === 0} onClick={() => handleExport('excel')}>
          {exportando === 'excel' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
          Exportar Excel
        </Button>
        <Button variant="outline" size="sm" className="gap-2" disabled={exportando !== null || pedidos.length === 0} onClick={() => handleExport('pdf')}>
          {exportando === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Exportar PDF
        </Button>
        <Button onClick={generarPedidos} disabled={generando} size="sm" className="gap-2">
          {generando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Generar pedidos desde el planificador
        </Button>
      </div>

      {pedidos.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">
          Todavía no hay pedidos generados para esta temporada.
        </CardContent></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="space-y-3">
            {pedidos.map((p) => (
              <Card
                key={p.id}
                className={p.id === selected?.id ? 'ring-1 ring-primary cursor-pointer' : 'cursor-pointer'}
                onClick={() => setSelectedId(p.id)}
              >
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium">{p.proveedor.nombre}</p>
                    <p className="text-xs text-muted-foreground">{new Date(p.fechaPedido).toLocaleDateString('es-ES')} · {p.lineas.length} artículos</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-sm">
                      {p.lineas.reduce((sum, l) => sum + precioFinalUnidad(l.precioSinIva, l.descuentoPercent, l.ivaPercent) * l.cantidad, 0).toFixed(2)}€
                    </p>
                    <Badge variant={STATUS_VARIANT[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {selected && (
            <Card className="lg:sticky lg:top-6 h-fit">
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{selected.proveedor.nombre}</p>
                    <p className="text-xs text-muted-foreground">{selected.temporada.nombre}</p>
                  </div>
                  <Badge variant={STATUS_VARIANT[selected.status]}>{STATUS_LABEL[selected.status]}</Badge>
                </div>

                <div className="space-y-1 text-sm">
                  {selected.lineas.map((l) => (
                    <div key={l.id} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{l.articulo.nombre} × {l.cantidad}</span>
                      <span>{(precioFinalUnidad(l.precioSinIva, l.descuentoPercent, l.ivaPercent) * l.cantidad).toFixed(2)}€</span>
                    </div>
                  ))}
                </div>

                <div className="flex justify-between font-semibold border-t border-border pt-2">
                  <span>Total c/IVA</span>
                  <span>
                    {selected.lineas.reduce((sum, l) => sum + precioFinalUnidad(l.precioSinIva, l.descuentoPercent, l.ivaPercent) * l.cantidad, 0).toFixed(2)}€
                  </span>
                </div>

                <div className="flex flex-col gap-2 pt-2">
                  {selected.status !== 'RECIBIDO' && (
                    <Button size="sm" className="gap-2" onClick={() => avanzarEstado(selected)}>
                      {selected.status === 'BORRADOR' ? <Send className="h-4 w-4" /> : <PackageCheck className="h-4 w-4" />}
                      Marcar como {STATUS_LABEL[SIGUIENTE_ESTADO[selected.status]].toLowerCase()}
                    </Button>
                  )}
                  {selected.status === 'RECIBIDO' && !selected.gasto && (
                    <Button size="sm" variant="outline" className="gap-2" onClick={() => setRegistrarGastoPedido(selected)}>
                      <Wallet className="h-4 w-4" /> Registrar como gasto
                    </Button>
                  )}
                  {selected.gasto && (
                    <p className="text-xs text-muted-foreground">Ya registrado como gasto ({selected.gasto.importeSinIva.toFixed(2)}€ s/IVA).</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <GastoDesdePedidoDialog
        pedido={registrarGastoPedido}
        onClose={() => setRegistrarGastoPedido(null)}
        onSaved={() => { setRegistrarGastoPedido(null); fetchPedidos(); }}
      />
    </div>
  );
}
