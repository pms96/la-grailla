'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Button, type buttonVariants } from '@/components/ui/button';
import type { VariantProps } from 'class-variance-authority';
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

interface AgeWarningGateProps {
  href: string;
  warningMessage: string | null;
  className?: string;
  size?: VariantProps<typeof buttonVariants>['size'];
  children: React.ReactNode;
}

// Intercepta el clic en "Comprar entradas": si el evento tiene aviso de edad
// mínima activado, exige confirmarlo en un modal antes de navegar a
// /comprar — igual cada vez que se pulse, no se recuerda entre visitas.
export function AgeWarningGate({ href, warningMessage, className, size, children }: AgeWarningGateProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (!warningMessage) {
    return (
      <Button size={size} className={className} onClick={() => router.push(href)}>
        {children}
      </Button>
    );
  }

  return (
    <>
      <Button size={size} className={className} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warm-yellow shrink-0" /> Antes de comprar
            </AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line text-foreground/90">
              {warningMessage}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => router.push(href)}>
              Entiendo y cumplo la edad mínima
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
