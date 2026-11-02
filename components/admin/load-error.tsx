import { Button } from '@/components/ui/button';

/* Aviso de una carga fallida en una pantalla del admin (H-176), con «Reintentar». Se pinta EN LUGAR de los datos: nunca una lista vacía ni totales a cero «de mentira». */
// H-237: toma el foco al montarse (al pulsar «Reintentar» la pantalla pasa a «cargando», el aviso se desmonta y el foco del teclado se perdía en el body). La función de ref es ESTABLE (fuera
// del componente): una en línea cambiaría en cada render de la pantalla y volvería a enfocar el aviso mientras se escribe en un filtro.
const focusOnMount = (el: HTMLDivElement | null) => el?.focus();

export function LoadError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div ref={focusOnMount} tabIndex={-1} role="alert" className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center text-sm outline-none">
      <p className="font-medium text-destructive-text">{title}</p>
      <p className="text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}
