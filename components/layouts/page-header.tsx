import { cn } from '@/lib/utils'

export function PageHeader({
  title, description, actions, className,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
}) {
  return (
    // H-166: con el bloque de acciones sin poder encoger, una barra ancha (Estadísticas: 631 px) empujaba la página fuera de un móvil de 375 px. Ahora la cabecera se
    // parte en filas y las acciones pueden envolver dentro de su propio bloque.
    <div className={cn('flex flex-wrap items-start justify-between gap-4 pb-6 border-b', className)}>
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  )
}
