'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Temporada } from '@prisma/client';
import { PageHeader } from '@/components/layouts/page-header';
import { useBrand } from '@/components/brand-provider';
import { descripcionContabilidad } from '@/lib/compras/constantes';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Loader2 } from 'lucide-react';
import { userMessage } from '@/lib/error-text';
import { fetchAdminJson } from '@/lib/admin-fetch';
import { LoadError } from '@/components/admin/load-error';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';
import { EventosEnlazados } from '@/app/admin/compras/_components/eventos-enlazados';
import { TabProveedores } from '@/app/admin/compras/_components/tab-proveedores';
import { TabArticulos } from '@/app/admin/compras/_components/tab-articulos';
import { TabPlanificador } from '@/app/admin/compras/_components/tab-planificador';
import { TabPedidos } from '@/app/admin/compras/_components/tab-pedidos';

export default function ComprasPage() {
  const { legacy } = useBrand();
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  const [temporadaId, setTemporadaId] = useState<string | null>(null);
  const [incluirArchivadas, setIncluirArchivadas] = useState(false);
  const [loading, setLoading] = useState(true);

  // H-222: un 401, 423 o 500 devolvía `{ error }` y la pantalla decía «Crea una temporada…» como si no hubiera ninguna.
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchTemporadas = useCallback((preferId?: string, incluirArchivadasParam?: boolean) => {
    const params = (incluirArchivadasParam ?? incluirArchivadas) ? '?incluirArchivados=1' : '';
    fetchAdminJson<Temporada[]>(`/api/admin/compras/temporadas${params}`, 'No se pudieron cargar las temporadas')
      .then((d) => {
        const list = Array.isArray(d) ? d : [];
        setTemporadas(list);
        setLoadError(null);
        setTemporadaId((prev) => {
          const prevSigueDisponible = prev && list.some((t) => t.id === prev);
          return preferId ?? (prevSigueDisponible ? prev : list[0]?.id ?? null);
        });
      })
      .catch((e) => setLoadError(userMessage(e, 'No se pudieron cargar las temporadas')))
      .finally(() => setLoading(false));
  }, [incluirArchivadas]);

  useEffect(() => { fetchTemporadas(); }, [fetchTemporadas]);

  const temporada = temporadas.find((t) => t.id === temporadaId) ?? null;

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  // H-222: sin temporadas por un error de carga no se enseña «Crea una temporada…».
  if (loadError && temporadas.length === 0) {
    return <LoadError title="No se han podido cargar las temporadas." message={loadError} onRetry={() => { setLoadError(null); setLoading(true); fetchTemporadas(); }} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Compras" description={descripcionContabilidad('compras', legacy)} className="pb-0 border-0" />
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

      <Tabs defaultValue="articulos">
        {/* H-166: a 375 px las cuatro pestañas en una línea medían 499 px: en móvil se parten en filas. */}
        <TabsList className="h-auto max-w-full flex-wrap justify-start">
          <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
          <TabsTrigger value="articulos">Artículos</TabsTrigger>
          <TabsTrigger value="planificador">Planificador</TabsTrigger>
          <TabsTrigger value="pedidos">Pedidos a proveedores</TabsTrigger>
        </TabsList>
        <TabsContent value="proveedores"><TabProveedores /></TabsContent>
        <TabsContent value="articulos"><TabArticulos /></TabsContent>
        <TabsContent value="planificador"><TabPlanificador temporada={temporada} /></TabsContent>
        <TabsContent value="pedidos"><TabPedidos temporada={temporada} /></TabsContent>
      </Tabs>
    </div>
  );
}
