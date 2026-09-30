'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Temporada, Ingreso } from '@prisma/client';
import type { WithNumberFields } from '@/lib/prisma';
import { PageHeader } from '@/components/layouts/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Plus, Pencil, Trash2, Coins } from 'lucide-react';
import { toast } from 'sonner';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';
import { ConfirmDeleteDialog } from '@/app/admin/_components/confirm-delete-dialog';
import { IngresoDialog } from '@/app/admin/ingresos/_components/ingreso-dialog';

type IngresoConRelaciones = WithNumberFields<Ingreso, 'importe'> & { createdBy: { id: string; name: string | null; email: string } | null };

type Resumen = {
  ingresoTotal: number;
  gastoTotal: number;
  balance: number;
  nIngresos: number;
  porDia: { fecha: string; total: number; lineas: { concepto: string; total: number }[] }[];
};

export default function IngresosPage() {
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  const [temporadaId, setTemporadaId] = useState<string | null>(null);
  const [incluirArchivadas, setIncluirArchivadas] = useState(false);
  const [ingresos, setIngresos] = useState<IngresoConRelaciones[]>([]);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WithNumberFields<Ingreso, 'importe'> | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IngresoConRelaciones | null>(null);

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
    fetchTemporadas().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchDatos = useCallback(() => {
    if (!temporadaId) { setIngresos([]); setResumen(null); return; }
    Promise.all([
      fetch(`/api/admin/ingresos?temporadaId=${temporadaId}`).then((r) => r.json()),
      fetch(`/api/admin/ingresos/resumen?temporadaId=${temporadaId}`).then((r) => r.json()),
    ])
      .then(([i, r]) => {
        setIngresos(Array.isArray(i) ? i : []);
        setResumen(r);
      })
      .catch(() => {});
  }, [temporadaId]);

  useEffect(() => { fetchDatos(); }, [fetchDatos]);

  const temporada = temporadas.find((t) => t.id === temporadaId) ?? null;

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (i: WithNumberFields<Ingreso, 'importe'>) => { setEditing(i); setDialogOpen(true); };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/admin/ingresos/${deleteTarget.id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Ingreso eliminado'); fetchDatos(); } else { toast.error('No se pudo eliminar'); }
    setDeleteTarget(null);
  };

  // Mismos registros que la lista, agrupados por día para que se vea como
  // la caja que se cuenta cada noche — el CRUD sigue siendo por línea suelta.
  const porDia = new Map<string, IngresoConRelaciones[]>();
  for (const i of ingresos) {
    const dia = new Date(i.fecha).toISOString().slice(0, 10);
    const bucket = porDia.get(dia) ?? [];
    bucket.push(i);
    porDia.set(dia, bucket);
  }
  const dias = Array.from(porDia.keys()).sort();

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Ingresos" description="Caja física de la caseta, día a día, por temporada" className="pb-0 border-0" />
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
      </div>

      {!temporada ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Crea una temporada para empezar a registrar ingresos.</p>
      ) : (
        <>
          <div className="grid sm:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Ingreso total ({temporada.nombre})</p>
                <p className="text-2xl font-bold text-green-500">{(resumen?.ingresoTotal ?? 0).toFixed(2)}€</p>
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
                <p className="text-xs text-muted-foreground">Balance — lo que queda al final</p>
                <p className={`text-2xl font-bold ${(resumen?.balance ?? 0) >= 0 ? 'text-green-500' : 'text-destructive'}`}>
                  {(resumen?.balance ?? 0) >= 0 ? '+' : ''}{(resumen?.balance ?? 0).toFixed(2)}€
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="flex justify-end">
            <Button onClick={openCreate} size="sm" className="gap-2"><Plus className="h-4 w-4" /> Nuevo ingreso</Button>
          </div>

          {dias.length === 0 ? (
            <Card><CardContent className="p-10 text-center text-muted-foreground">
              <Coins className="h-8 w-8 mx-auto mb-3 opacity-50" /> Sin ingresos registrados todavía en esta temporada.
            </CardContent></Card>
          ) : (
            <div className="space-y-4">
              {dias.map((dia) => {
                const lineas = porDia.get(dia) ?? [];
                const totalDia = lineas.reduce((acc, i) => acc + i.importe, 0);
                return (
                  <Card key={dia}>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium">
                          {new Date(dia).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                        </p>
                        <span className="font-bold text-green-500">{totalDia.toFixed(2)}€</span>
                      </div>
                      <div className="space-y-2">
                        {lineas.map((i) => (
                          <div key={i.id} className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-muted/50">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant="outline">{i.concepto}</Badge>
                                {i.notas && <p className="text-xs text-muted-foreground truncate">{i.notas}</p>}
                              </div>
                              {i.createdBy && (
                                <p className="text-xs text-muted-foreground mt-0.5">Registrado por {i.createdBy.name ?? i.createdBy.email}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="font-semibold">{i.importe.toFixed(2)}€</span>
                              <Button variant="ghost" size="icon-sm" onClick={() => openEdit(i)}><Pencil className="h-3.5 w-3.5" /></Button>
                              <Button variant="ghost" size="icon-sm" onClick={() => setDeleteTarget(i)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      <IngresoDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        temporadaId={temporadaId}
        onSaved={fetchDatos}
      />

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="Eliminar ingreso"
        description={
          deleteTarget
            ? `Se eliminará el ingreso de "${deleteTarget.concepto}" por ${deleteTarget.importe.toFixed(2)}€ del ${new Date(deleteTarget.fecha).toLocaleDateString('es-ES')}. Esta acción no se puede deshacer.`
            : ''
        }
        onConfirm={confirmDelete}
      />
    </div>
  );
}
