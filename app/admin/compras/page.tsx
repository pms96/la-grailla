'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Temporada } from '@prisma/client';
import { PageHeader } from '@/components/layouts/page-header';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Loader2 } from 'lucide-react';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';
import { EventosEnlazados } from '@/app/admin/compras/_components/eventos-enlazados';
import { TabProveedores } from '@/app/admin/compras/_components/tab-proveedores';
import { TabArticulos } from '@/app/admin/compras/_components/tab-articulos';
import { TabPlanificador } from '@/app/admin/compras/_components/tab-planificador';
import { TabPedidos } from '@/app/admin/compras/_components/tab-pedidos';

export default function ComprasPage() {
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  const [temporadaId, setTemporadaId] = useState<string | null>(null);
  const [incluirArchivadas, setIncluirArchivadas] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchTemporadas = useCallback((preferId?: string, incluirArchivadasParam?: boolean) => {
    const params = (incluirArchivadasParam ?? incluirArchivadas) ? '?incluirArchivados=1' : '';
    fetch(`/api/admin/compras/temporadas${params}`)
      .then((r) => r.json())
      .then((d: Temporada[]) => {
        const list = Array.isArray(d) ? d : [];
        setTemporadas(list);
        setTemporadaId((prev) => {
          const prevSigueDisponible = prev && list.some((t) => t.id === prev);
          return preferId ?? (prevSigueDisponible ? prev : list[0]?.id ?? null);
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [incluirArchivadas]);

  useEffect(() => { fetchTemporadas(); }, [fetchTemporadas]);

  const temporada = temporadas.find((t) => t.id === temporadaId) ?? null;

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Compras" description="Catálogo, comparativa de precios y pedidos de la caseta" className="pb-0 border-0" />
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
        <TabsList>
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
