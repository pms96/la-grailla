'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Temporada, Gasto, Proveedor } from '@prisma/client';
import { PageHeader } from '@/components/layouts/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Pencil, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';
import { EventosEnlazados } from '@/app/admin/compras/_components/eventos-enlazados';
import { ConfirmDeleteDialog } from '@/app/admin/_components/confirm-delete-dialog';
import { GastoDialog } from '@/app/admin/gastos/_components/gasto-dialog';
import { AhorroBarChart } from '@/app/admin/gastos/_components/ahorro-bar-chart';
import { GastoPieChart } from '@/app/admin/gastos/_components/gasto-pie-chart';
import { ComparativoBarChart } from '@/app/admin/gastos/_components/comparativo-bar-chart';
import { CATEGORIAS_GASTO } from '@/lib/compras/constantes';

type GastoConRelaciones = Gasto & { proveedor: Proveedor | null; createdBy: { id: string; name: string | null; email: string } | null };

type Resumen = {
  gastoTotal: number;
  gastoTotalAnterior: number;
  nGastos: number;
  temporadaAnterior: Temporada | null;
  porCategoria: { categoria: string; total: number }[];
  comparativoCategorias: { categoria: string; actual: number; anterior: number }[];
  topAhorro: { articulo: string; ahorroTotal: number; proveedorRecomendado: string | null }[];
  ingresos: number;
  margen: number;
  nEventosEnlazados: number;
};

export default function GastosPage() {
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  const [temporadaId, setTemporadaId] = useState<string | null>(null);
  const [incluirArchivadas, setIncluirArchivadas] = useState(false);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [gastos, setGastos] = useState<GastoConRelaciones[]>([]);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [categoriaFiltro, setCategoriaFiltro] = useState<string>('__all__');
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Gasto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GastoConRelaciones | null>(null);

  const fetchTemporadas = useCallback((preferId?: string, incluirArchivadasParam?: boolean) => {
    const params = (incluirArchivadasParam ?? incluirArchivadas) ? '?incluirArchivados=1' : '';
    return fetch(`/api/admin/compras/temporadas${params}`)
      .then((r) => r.json())
      .then((d: Temporada[]) => {
        const list = Array.isArray(d) ? d : [];
        setTemporadas(list);
        setTemporadaId((prev) => {
          const prevSigueDisponible = prev && list.some((t) => t.id === prev);
          return preferId ?? (prevSigueDisponible ? prev : list[0]?.id ?? null);
        });
      })
      .catch(() => {});
  }, [incluirArchivadas]);

  useEffect(() => {
    Promise.all([
      fetchTemporadas(),
      fetch('/api/admin/compras/proveedores').then((r) => r.json()).then((p) => setProveedores(Array.isArray(p) ? p : [])),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchDatos = useCallback(() => {
    if (!temporadaId) { setGastos([]); setResumen(null); return; }
    const params = new URLSearchParams({ temporadaId });
    if (categoriaFiltro !== '__all__') params.set('categoria', categoriaFiltro);
    Promise.all([
      fetch(`/api/admin/gastos?${params}`).then((r) => r.json()),
      fetch(`/api/admin/gastos/resumen?temporadaId=${temporadaId}`).then((r) => r.json()),
    ])
      .then(([g, r]) => {
        setGastos(Array.isArray(g) ? g : []);
        setResumen(r);
      })
      .catch(() => {});
  }, [temporadaId, categoriaFiltro]);

  useEffect(() => { fetchDatos(); }, [fetchDatos]);

  const temporada = temporadas.find((t) => t.id === temporadaId) ?? null;

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (g: Gasto) => { setEditing(g); setDialogOpen(true); };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/admin/gastos/${deleteTarget.id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Gasto eliminado'); fetchDatos(); } else { toast.error('No se pudo eliminar'); }
    setDeleteTarget(null);
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Gastos" description="Contabilidad real de la caseta por temporada" className="pb-0 border-0" />
        <div className="flex flex-col items-end gap-1.5">
          <TemporadaSelector
            temporadas={temporadas}
            temporadaId={temporadaId}
            onChange={setTemporadaId}
            onTemporadaCreada={(t) => { setTemporadas((prev) => [t, ...prev]); setTemporadaId(t.id); }}
            showArchiveControls
            incluirArchivadas={incluirArchivadas}
            onIncluirArchivadasChange={(v) => { setIncluirArchivadas(v); fetchTemporadas(undefined, v); }}
            onTemporadasChanged={() => fetchTemporadas()}
          />
          <EventosEnlazados temporadaId={temporadaId} />
        </div>
      </div>

      {!temporada ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Crea una temporada para empezar a registrar gastos.</p>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Ingresos ({temporada.nombre})</p>
                {resumen && resumen.nEventosEnlazados === 0 ? (
                  <p className="text-sm text-muted-foreground mt-1">
                    Sin eventos enlazados —{' '}
                    <a href="/admin/eventos" className="underline text-primary">enlázalos aquí</a>
                  </p>
                ) : (
                  <p className="text-2xl font-bold text-green-500">{(resumen?.ingresos ?? 0).toFixed(2)}€</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Margen ({temporada.nombre})</p>
                {resumen && resumen.nEventosEnlazados === 0 ? (
                  <p className="text-sm text-muted-foreground mt-1">Sin eventos enlazados</p>
                ) : (
                  <p className={`text-2xl font-bold ${(resumen?.margen ?? 0) >= 0 ? 'text-green-500' : 'text-destructive'}`}>
                    {(resumen?.margen ?? 0) >= 0 ? '+' : ''}{(resumen?.margen ?? 0).toFixed(2)}€
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Gasto total ({temporada.nombre})</p>
                <p className="text-2xl font-bold">{(resumen?.gastoTotal ?? 0).toFixed(2)}€</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">
                  {resumen?.temporadaAnterior ? `Gasto ${resumen.temporadaAnterior.nombre}` : 'Sin temporada anterior'}
                </p>
                <p className="text-2xl font-bold">{(resumen?.gastoTotalAnterior ?? 0).toFixed(2)}€</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Nº de gastos registrados</p>
                <p className="text-2xl font-bold">{resumen?.nGastos ?? 0}</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Gasto por categoría</CardTitle></CardHeader>
              <CardContent><GastoPieChart data={resumen?.porCategoria ?? []} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Top 10 ahorro estimado (planificador)</CardTitle></CardHeader>
              <CardContent><AhorroBarChart data={resumen?.topAhorro ?? []} /></CardContent>
            </Card>
            {resumen?.temporadaAnterior && (
              <Card className="lg:col-span-2">
                <CardHeader><CardTitle className="text-base">Comparativo por categoría: {resumen.temporadaAnterior.nombre} vs {temporada.nombre}</CardTitle></CardHeader>
                <CardContent>
                  <ComparativoBarChart data={resumen.comparativoCategorias} labelAnterior={resumen.temporadaAnterior.nombre} labelActual={temporada.nombre} />
                </CardContent>
              </Card>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Select value={categoriaFiltro} onValueChange={setCategoriaFiltro}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas las categorías</SelectItem>
                {CATEGORIAS_GASTO.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button onClick={openCreate} size="sm" className="gap-2"><Plus className="h-4 w-4" /> Nuevo gasto</Button>
          </div>

          {gastos.length === 0 ? (
            <Card><CardContent className="p-10 text-center text-muted-foreground">
              <Wallet className="h-8 w-8 mx-auto mb-3 opacity-50" /> Sin gastos registrados con este filtro.
            </CardContent></Card>
          ) : (
            <div className="space-y-3">
              {gastos.map((g) => (
                <Card key={g.id}>
                  <CardContent className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">{g.concepto}</p>
                        <Badge variant="outline">{g.categoria}</Badge>
                        {g.tipoDocumento !== 'Factura' && <Badge variant="secondary">{g.tipoDocumento}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {new Date(g.fecha).toLocaleDateString('es-ES')}
                        {g.proveedor ? ` · ${g.proveedor.nombre}` : ''}
                        {g.numDocumento ? ` · Nº ${g.numDocumento}` : ''}
                        {g.createdBy ? ` · Registrado por ${g.createdBy.name ?? g.createdBy.email}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`font-bold ${g.importeSinIva < 0 ? 'text-destructive' : ''}`}>
                        {(g.importeSinIva * (1 + g.ivaPercent / 100)).toFixed(2)}€
                      </span>
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(g)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setDeleteTarget(g)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <GastoDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        temporadaId={temporadaId}
        proveedores={proveedores}
        onSaved={fetchDatos}
      />

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="Eliminar gasto"
        description={
          deleteTarget
            ? `Se eliminará "${deleteTarget.concepto}" por ${(deleteTarget.importeSinIva * (1 + deleteTarget.ivaPercent / 100)).toFixed(2)}€ del ${new Date(deleteTarget.fecha).toLocaleDateString('es-ES')}. Esta acción no se puede deshacer.`
            : ''
        }
        onConfirm={confirmDelete}
      />
    </div>
  );
}
