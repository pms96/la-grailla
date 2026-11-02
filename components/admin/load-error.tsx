import { Button } from '@/components/ui/button';

/* Aviso de una carga fallida en una pantalla del admin (H-176), con «Reintentar». Se pinta EN LUGAR de los datos: nunca una lista vacía ni totales a cero «de mentira». */
export function LoadError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center text-sm">
      <p className="font-medium text-destructive-text">{title}</p>
      <p className="text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}
