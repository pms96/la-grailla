'use client';

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

type SalesDay = { date: string; revenue: number; count: number };

export default function SalesChart({ data }: { data: SalesDay[] }) {
  if (!data?.length) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Sin ventas en el periodo seleccionado.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="salesRevenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
            <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={36} />
        <Tooltip
          contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
          labelFormatter={(d: string) => new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'long' })}
          formatter={(value: number, name: string) => [name === 'revenue' ? `${value.toFixed(2)}€` : value, name === 'revenue' ? 'Ingresos' : 'Pedidos']}
        />
        <Area type="monotone" dataKey="revenue" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#salesRevenue)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
