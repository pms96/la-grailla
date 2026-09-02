'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Temporada } from '@prisma/client';
import { PageHeader } from '@/components/layouts/page-header';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Loader2 } from 'lucide-react';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';
import { TabProveedores } from '@/app/admin/compras/_components/tab-proveedores';
import { TabArticulos } from '@/app/admin/compras/_components/tab-articulos';
import { TabPlanificador } from '@/app/admin/compras/_components/tab-planificador';
import { TabPedidos } from '@/app/admin/compras/_components/tab-pedidos';

export default function ComprasPage() {
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  const [temporadaId, setTemporadaId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchTemporadas = useCallback((preferId?: string) => {
    fetch('/api/admin/compras/temporadas')
      .then((r) => r.json())
      .then((d: Temporada[]) => {
        const list = Array.isArray(d) ? d : [];
        setTemporadas(list);
        setTemporadaId((prev) => preferId ?? prev ?? list[0]?.id ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchTemporadas(); }, [fetchTemporadas]);

  const temporada = temporadas.find((t) => t.id === temporadaId) ?? null;

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Compras" description="Catálogo, comparativa de precios y pedidos de la caseta" className="pb-0 border-0" />
        <TemporadaSelector
          temporadas={temporadas}
          temporadaId={temporadaId}
          onChange={setTemporadaId}
          onTemporadaCreada={(t) => { setTemporadas((prev) => [t, ...prev]); setTemporadaId(t.id); }}
        />
      </div>

      <Tabs defaultValue="articulos">
        <TabsList>
          <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
          <TabsTrigger value="articulos">Artículos</TabsTrigger>
          <TabsTrigger value="planificador">Planificador</TabsTrigger>
          <TabsTrigger value="pedidos">Pedidos</TabsTrigger>
        </TabsList>
        <TabsContent value="proveedores"><TabProveedores /></TabsContent>
        <TabsContent value="articulos"><TabArticulos /></TabsContent>
        <TabsContent value="planificador"><TabPlanificador temporada={temporada} /></TabsContent>
        <TabsContent value="pedidos"><TabPedidos temporada={temporada} /></TabsContent>
      </Tabs>
    </div>
  );
}
