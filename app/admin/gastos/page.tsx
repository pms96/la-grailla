'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Temporada, Gasto, Proveedor } from '@prisma/client';
import type { WithNumberFields } from '@/lib/prisma';
import { PageHeader } from '@/components/layouts/page-header';
import { useBrand } from '@/components/brand-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Pencil, Trash2, Wallet, FileSpreadsheet, FileText } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';
import { EventosEnlazados } from '@/app/admin/compras/_components/eventos-enlazados';
import { ConfirmDeleteDialog } from '@/app/admin/_components/confirm-delete-dialog';
import { GastoDialog } from '@/app/admin/gastos/_components/gasto-dialog';
import { GastoPieChart } from '@/app/admin/gastos/_components/gasto-pie-chart';
import { ComparativoBarChart } from '@/app/admin/gastos/_components/comparativo-bar-chart';
import { CATEGORIAS_GASTO, descripcionContabilidad } from '@/lib/compras/constantes';
import { downloadGastosExport } from '@/lib/gastos/gastos-export';
import { userMessage } from '@/lib/error-text';
import { fetchAdminJson, responseError } from '@/lib/admin-fetch';
import { LoadError } from '@/components/admin/load-error';
import { createLatest } from '@/lib/latest-request';
import { importeGastoConIva } from '@/lib/gasto-calc';

type GastoConRelaciones = WithNumberFields<Gasto, 'importeSinIva' | 'ivaPercent'> & { proveedor: Proveedor | null; createdBy: { id: string; name: string | null; email: string } | null };

type Resumen = {
  gastoTotal: number;
  gastoTotalAnterior: number;
  nGastos: number;
  temporadaAnterior: Temporada | null;
  porCategoria: { categoria: string; total: number }[];
  comparativoCategorias: { categoria: string; actual: number; anterior: number }[];
};

export default function GastosPage() {
  const { legacy } = useBrand();
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  const [temporadaId, setTemporadaId] = useState<string | null>(null);
  const [incluirArchivadas, setIncluirArchivadas] = useState(false);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [gastos, setGastos] = useState<GastoConRelaciones[]>([]);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [categoriaFiltro, setCategoriaFiltro] = useState<string>('__all__');
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WithNumberFields<Gasto, 'importeSinIva' | 'ivaPercent'> | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GastoConRelaciones | null>(null);
  const [exportando, setExportando] = useState<'excel' | 'pdf' | null>(null);
  // H-176: una carga fallida se ENSEÑA (con «Reintentar») en lugar de pintar una lista vacía y «0,00 €».
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchTemporadas = useCallback((preferId?: string, incluirArchivadasParam?: boolean) => {
    const params = (incluirArchivadasParam ?? incluirArchivadas) ? '?incluirArchivados=1' : '';
    return fetchAdminJson<Temporada[]>(`/api/admin/compras/temporadas${params}`, 'No se pudieron cargar las temporadas')
      .then((d) => {
        const list = Array.isArray(d) ? d : [];
        setTemporadas(list);
        setTemporadaId((prev) => {
          const prevSigueDisponible = prev && list.some((t) => t.id === prev);
          return preferId ?? (prevSigueDisponible ? prev : list[0]?.id ?? null);
        });
      })
      .catch((e) => setLoadError(userMessage(e, 'No se pudieron cargar las temporadas')));
  }, [incluirArchivadas]);

  // H-224: la carga inicial (temporadas y proveedores) es una función: «Reintentar» la repite entera (antes solo repetía las temporadas y dejaba el desplegable de proveedores vacío sin avisar).
  const loadBase = useCallback(() => {
    setLoading(true);
    return Promise.all([
      fetchTemporadas(),
      fetchAdminJson<Proveedor[]>('/api/admin/compras/proveedores', 'No se pudieron cargar los proveedores').then((p) => setProveedores(Array.isArray(p) ? p : [])),
    ])
      .catch((e) => setLoadError(userMessage(e, 'No se pudieron cargar los proveedores')))
      .finally(() => setLoading(false));
  }, [fetchTemporadas]);

  useEffect(() => {
    void loadBase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // H-225: solo vale la respuesta de la última petición (cambiar de temporada o de categoría relanza la carga).
  const latest = useRef(createLatest());
  const [datosLoading, setDatosLoading] = useState(false);
  const fetchDatos = useCallback(() => {
    if (!temporadaId) { setGastos([]); setResumen(null); return; }
    const id = latest.current.next();
    setDatosLoading(true);
    const params = new URLSearchParams({ temporadaId });
    if (categoriaFiltro !== '__all__') params.set('categoria', categoriaFiltro);
    Promise.all([
      fetchAdminJson<GastoConRelaciones[]>(`/api/admin/gastos?${params}`, 'No se pudieron cargar los gastos'),
      fetchAdminJson<Resumen>(`/api/admin/gastos/resumen?temporadaId=${temporadaId}`, 'No se pudo cargar el resumen de gastos'),
    ])
      .then(([g, r]) => {
        if (!latest.current.isCurrent(id)) return;
        setGastos(Array.isArray(g) ? g : []);
        setResumen(r);
        setLoadError(null);
      })
      .catch((e) => {
        if (!latest.current.isCurrent(id)) return;
        // Sin datos, nada de totales a cero: se vacía y se enseña el error.
        setGastos([]);
        setResumen(null);
        setLoadError(userMessage(e, 'No se pudieron cargar los gastos'));
      })
      .finally(() => {
        if (latest.current.isCurrent(id)) setDatosLoading(false);
      });
  }, [temporadaId, categoriaFiltro]);

  useEffect(() => { fetchDatos(); }, [fetchDatos]);

  const temporada = temporadas.find((t) => t.id === temporadaId) ?? null;
  const { data: session } = useSession();
  const puedeAnular = !session?.user?.modules && temporada?.status !== 'CERRADA';

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (g: WithNumberFields<Gasto, 'importeSinIva' | 'ivaPercent'>) => { setEditing(g); setDialogOpen(true); };

  // Un gasto no se borra: se anula, con motivo. Deja de contar en las cifras y el registro de auditoría guarda quién y por qué.
  const confirmDelete = async (motivo?: string) => {
    if (!deleteTarget) return false;
    try {
      const res = await fetch(`/api/admin/gastos/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo }),
      });
      if (res.ok) { toast.success('Gasto anulado'); fetchDatos(); return true; }
      // Si falla, el diálogo se queda abierto con el motivo escrito (H-011).
      toast.error(await responseError(res, 'No se pudo anular el gasto'));
    } catch (e) {
      toast.error(userMessage(e, 'No se pudo anular el gasto'));
    }
    return false;
  };

  const handleExport = async (format: 'excel' | 'pdf') => {
    if (!temporadaId) return;
    setExportando(format);
    try {
      await downloadGastosExport(temporadaId, format);
      toast.success(format === 'excel' ? 'Excel de gastos descargado' : 'PDF de gastos descargado');
    } catch (e) {
      toast.error(userMessage(e, 'Error al exportar'));
    } finally {
      setExportando(null);
    }
  };

  // H-224: mientras llegan los datos de un reintento (sin resumen todavía) se enseña la carga, no «0,00 €» ni «Sin gastos».
  if (loading || (datosLoading && !resumen)) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Gastos" description={descripcionContabilidad('gastos', legacy)} className="pb-0 border-0" />
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

      {loadError ? (
        <LoadError title="No se han podido cargar los gastos." message={loadError} onRetry={() => { setLoadError(null); setLoading(true); void loadBase(); fetchDatos(); }} />
      ) : !temporada ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Crea una temporada para empezar a registrar gastos.</p>
      ) : (
        <>
          <div className="grid sm:grid-cols-3 gap-4">
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

          <Card>
            <CardHeader><CardTitle className="text-base">Gasto por categoría</CardTitle></CardHeader>
            <CardContent><GastoPieChart data={resumen?.porCategoria ?? []} /></CardContent>
          </Card>
          {resumen?.temporadaAnterior && (
            <Card>
              <CardHeader><CardTitle className="text-base">Comparativo por categoría: {resumen.temporadaAnterior.nombre} vs {temporada.nombre}</CardTitle></CardHeader>
              <CardContent>
                <ComparativoBarChart data={resumen.comparativoCategorias} labelAnterior={resumen.temporadaAnterior.nombre} labelActual={temporada.nombre} />
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Select value={categoriaFiltro} onValueChange={setCategoriaFiltro}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas las categorías</SelectItem>
                {CATEGORIAS_GASTO.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="gap-2" disabled={exportando !== null || gastos.length === 0} onClick={() => handleExport('excel')}>
                {exportando === 'excel' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                Exportar Excel
              </Button>
              <Button variant="outline" size="sm" className="gap-2" disabled={exportando !== null || gastos.length === 0} onClick={() => handleExport('pdf')}>
                {exportando === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                Exportar PDF
              </Button>
              <Button onClick={openCreate} size="sm" className="gap-2" disabled={temporada?.status === 'CERRADA'} title={temporada?.status === 'CERRADA' ? 'Temporada cerrada: el propietario puede reabrirla' : undefined}><Plus className="h-4 w-4" /> Nuevo gasto</Button>
            </div>
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
                      <span className={`font-bold ${g.importeSinIva < 0 ? 'text-destructive-text' : ''}`}>
                        {importeGastoConIva(g.importeSinIva, g.ivaPercent).toFixed(2)}€
                      </span>
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(g)}><Pencil className="h-4 w-4" /></Button>
                      {/* Anular es solo del propietario y con la temporada abierta: a nadie más se le ofrece un botón que acabaría en 403 o 423 (H-011). */}
                      {puedeAnular && (
                        <Button variant="ghost" size="icon-sm" aria-label="Anular gasto" onClick={() => setDeleteTarget(g)}><Trash2 className="h-4 w-4 text-destructive-text" /></Button>
                      )}
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
        title="Anular gasto"
        description={
          deleteTarget
            ? `Se anulará "${deleteTarget.concepto}" por ${importeGastoConIva(deleteTarget.importeSinIva, deleteTarget.ivaPercent).toFixed(2)}€ del ${new Date(deleteTarget.fecha).toLocaleDateString('es-ES')}. Dejará de contar en las cifras; queda registrado quién lo anuló y por qué.`
            : ''
        }
        confirmLabel="Anular gasto"
        reasonLabel="Motivo de la anulación"
        onConfirm={confirmDelete}
      />
    </div>
  );
}
