'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type Fila = { categoria: string; actual: number; anterior: number };

export function ComparativoBarChart({ data, labelAnterior, labelActual }: { data: Fila[]; labelAnterior: string; labelActual: string }) {
  if (!data?.length) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Sin datos para comparar todavía.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="categoria" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} interval={0} angle={-20} textAnchor="end" height={60} />
        <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={36} />
        <Tooltip
          contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
          formatter={(value: number) => `${value.toFixed(2)}€`}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => (v === 'anterior' ? labelAnterior : labelActual)} />
        <Bar dataKey="anterior" name="anterior" fill="hsl(var(--chart-5))" radius={[4, 4, 0, 0]} />
        <Bar dataKey="actual" name="actual" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
