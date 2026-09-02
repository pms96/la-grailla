'use client';

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type Fila = { categoria: string; total: number };

const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

export function GastoPieChart({ data }: { data: Fila[] }) {
  const filtrado = data.filter((d) => d.total > 0);
  if (!filtrado.length) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Sin gastos registrados todavía para esta temporada.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie data={filtrado} dataKey="total" nameKey="categoria" innerRadius={50} outerRadius={90} paddingAngle={2}>
          {filtrado.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip
          contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
          formatter={(value: number) => [`${value.toFixed(2)}€`, 'Gasto']}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
