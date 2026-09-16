import { Badge } from '@/components/ui/badge';

type Variant = 'default' | 'secondary' | 'destructive' | 'outline';

// Badge con color por estado, genérico sobre cualquier enum — mismo patrón ya
// usado en app/admin/ventas/page.tsx (statusLabels + statusVariant), extraído
// aquí para no repetirlo en cada pantalla admin.
export function StatusBadge<T extends string>({
  status,
  labels,
  variants,
  className,
}: {
  status: T;
  labels: Record<T, string>;
  variants: Record<T, Variant>;
  className?: string;
}) {
  return (
    <Badge variant={variants[status]} className={className}>
      {labels[status] ?? status}
    </Badge>
  );
}
