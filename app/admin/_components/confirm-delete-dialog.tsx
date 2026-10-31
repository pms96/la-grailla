'use client';

import { useEffect, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
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
  onConfirm: (reason?: string) => void;
  confirmLabel?: string;
  // Con esta etiqueta el diálogo pide un motivo antes de confirmar (anular un gasto, reabrir una temporada…): queda en el registro de auditoría.
  reasonLabel?: string;
  // Por defecto el motivo es obligatorio (mínimo `reasonMin` caracteres); con `false` es opcional.
  reasonRequired?: boolean;
  reasonMin?: number;
};

// Sustituye a confirm() nativo para borrados (Fase 5 del plan de actuación):
// con más de una persona usando el panel, confirmar "a ciegas" deja de ser
// seguro — este diálogo siempre muestra qué registro concreto se borra.
export function ConfirmDeleteDialog({
  open, onOpenChange, title, description, onConfirm, confirmLabel = 'Eliminar', reasonLabel, reasonRequired = true, reasonMin = 5,
}: Props) {
  const [reason, setReason] = useState('');
  // Cada vez que se abre, el motivo empieza vacío: no arrastra el de la última anulación.
  useEffect(() => { if (open) setReason(''); }, [open]);
  const trimmed = reason.trim();
  const reasonMissing = Boolean(reasonLabel) && reasonRequired && trimmed.length < reasonMin;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {reasonLabel && (
          <div className="space-y-1.5">
            <label htmlFor="confirm-reason" className="text-sm font-medium">{reasonLabel}{reasonRequired ? ' *' : ''}</label>
            <Textarea id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm(reasonLabel ? trimmed : undefined)}
            disabled={reasonMissing}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
