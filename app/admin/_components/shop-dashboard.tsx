'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, DollarSign, Package, Receipt, ShoppingBag, Truck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SkeletonPulse } from '@/components/ui/animate';
import { useBrand } from '@/components/brand-provider';
import type { ShopStats } from '@/lib/shop-stats';

/* Dashboard de la tienda. Es el panel de inicio cuando el cliente no tiene Entradas; con Entradas, va debajo del suyo (`embedded`). */

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente', PAID: 'Pagado', PROCESSING: 'Procesando', SHIPPED: 'Enviado', DELIVERED: 'Entregado', CANCELLED: 'Cancelado', REFUNDED: 'Reembolsado',
};
const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });

function SalesChart({ daily }: { daily: ShopStats['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.revenue));
  const total = daily.reduce((s, d) => s + d.revenue, 0);
  return (
    <figure>
      <figcaption className="mb-3 flex items-baseline justify-between gap-3">
        <span className="font-display text-lg font-bold">Ventas de los últimos {daily.length} días</span>
        <span className="font-mono text-sm text-muted-foreground">{eur.format(total)}</span>
      </figcaption>
      <div className="flex h-32 items-end gap-0.5" role="img" aria-label={`Ventas diarias de los últimos ${daily.length} días: ${eur.format(total)} en total`}>
        {daily.map((d) => (
          <div key={d.date} className="group relative flex-1" style={{ height: '100%' }}>
            <div
              className="absolute inset-x-0 bottom-0 rounded-t-sm bg-primary/70 transition-colors group-hover:bg-primary"
              style={{ height: `${d.revenue > 0 ? Math.max(4, (d.revenue / max) * 100) : 0}%` }}
              title={`${day.format(new Date(`${d.date}T12:00:00`))}: ${eur.format(d.revenue)} · ${d.orders} pedido${d.orders === 1 ? '' : 's'}`}
            />
            {d.revenue === 0 && <div className="absolute inset-x-0 bottom-0 h-px bg-border" />}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-xs text-muted-foreground">
        <span>{day.format(new Date(`${daily[0]?.date}T12:00:00`))}</span>
        <span>{day.format(new Date(`${daily[daily.length - 1]?.date}T12:00:00`))}</span>
      </div>
    </figure>
  );
}

export default function ShopDashboard({ embedded = false }: { embedded?: boolean }) {
  const { name: brandName } = useBrand();
  const [stats, setStats] = useState<ShopStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/admin/shop-stats')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setStats)
      .catch(() => setFailed(true));
  }, []);

  const heading = embedded ? (
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-display text-xl font-bold tracking-tight">Tienda</h2>
      <Button variant="ghost" size="sm" asChild><Link href="/admin/pedidos">Ver pedidos</Link></Button>
    </div>
  ) : (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">Dashboard</h1>
        <p className="mt-1 text-muted-foreground">Resumen de la tienda de {brandName}</p>
      </div>
      <Button variant="outline" size="sm" className="shrink-0 gap-2" asChild>
        <Link href="/admin/pedidos"><Package className="h-4 w-4" /> Ver pedidos</Link>
      </Button>
    </div>
  );

  if (failed) {
    return <div className="space-y-6">{heading}<p role="alert" className="text-sm text-destructive">No se han podido cargar los datos de la tienda.</p></div>;
  }
  if (!stats) {
    return (
      <div className="space-y-6">
        {heading}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="space-y-2.5 p-4"><SkeletonPulse className="h-5 w-24" /><SkeletonPulse className="h-7 w-16" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const cards = [
    { label: 'Ingresos', value: eur.format(stats.revenue), icon: DollarSign, color: 'text-lima' },
    { label: 'Pedidos cobrados', value: stats.orders, icon: Receipt, color: 'text-primary' },
    { label: 'Por enviar', value: stats.toShip, icon: Truck, color: stats.toShip > 0 ? 'text-warm-yellow' : 'text-muted-foreground' },
    { label: 'Ticket medio', value: eur.format(stats.averageOrder), icon: ShoppingBag, color: 'text-lavender' },
  ];

  return (
    <div className="space-y-6">
      {heading}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <div className="mb-2 flex items-center gap-2">
                <c.icon className={`h-5 w-5 ${c.color}`} aria-hidden />
                <span className="text-xs text-muted-foreground">{c.label}</span>
              </div>
              <p className="font-display text-2xl font-bold">{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card><CardContent className="p-6"><SalesChart daily={stats.daily} /></CardContent></Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card><CardContent className="p-6">
          <h2 className="mb-4 font-display text-lg font-bold">Más vendidos</h2>
          {stats.topProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay ventas. Cuando se cobre el primer pedido aparecerán aquí tus productos más vendidos.</p>
          ) : (
            <ol className="space-y-3">
              {stats.topProducts.map((p) => (
                <li key={p.productId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium">{p.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{p.units} ud · {eur.format(p.revenue)}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent></Card>

        <Card><CardContent className="p-6">
          <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-bold">
            {stats.lowStock.length > 0 && <AlertTriangle className="h-4 w-4 text-warm-yellow" aria-hidden />} Poco stock
          </h2>
          {stats.lowStock.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ningún producto activo se está quedando sin stock.</p>
          ) : (
            <ul className="space-y-3">
              {stats.lowStock.map((v) => (
                <li key={`${v.productId}-${v.size}-${v.color}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{v.name}{(v.size || v.color) && <span className="text-muted-foreground"> · {[v.size, v.color].filter(Boolean).join(' / ')}</span>}</span>
                  <Badge variant={v.stock === 0 ? 'destructive' : 'secondary'}>{v.stock === 0 ? 'Agotado' : `${v.stock} ud`}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent></Card>
      </div>

      <Card><CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-display text-lg font-bold">Últimos pedidos</h2>
          <Button variant="ghost" size="sm" className="gap-2" asChild><Link href="/admin/pedidos">Ver todos <ArrowRight className="h-4 w-4" /></Link></Button>
        </div>
        {stats.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay pedidos.</p>
        ) : (
          <ul className="divide-y divide-border">
            {stats.recent.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="min-w-0"><span className="font-medium">{o.buyerName}</span> <span className="font-mono text-xs text-muted-foreground">#{o.id.slice(0, 8)}</span></span>
                <span className="flex items-center gap-3">
                  <span className="font-mono">{eur.format(o.totalAmount)}</span>
                  <Badge variant="secondary">{STATUS_LABELS[o.status] ?? o.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent></Card>
    </div>
  );
}
