'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  // Debe nombrar el registro exacto que se va a borrar (concepto/importe,
  // nombre del evento...) — nunca un genérico "¿Eliminar este elemento?".
  description: React.ReactNode;
  onConfirm: () => void;
  confirmLabel?: string;
};

// Sustituye a confirm() nativo para borrados (Fase 5 del plan de actuación):
// con más de una persona usando el panel, confirmar "a ciegas" deja de ser
// seguro — este diálogo siempre muestra qué registro concreto se borra.
export function ConfirmDeleteDialog({ open, onOpenChange, title, description, onConfirm, confirmLabel = 'Eliminar' }: Props) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
