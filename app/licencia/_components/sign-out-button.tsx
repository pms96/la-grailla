'use client';

import { signOut } from 'next-auth/react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Cerrar sesión desde el aviso de licencia (el login sigue abierto aunque el panel o el sitio estén bloqueados). */
export function LicenseSignOut() {
  return (
    <Button variant="ghost" size="lg" className="gap-2 font-display font-semibold" onClick={() => signOut({ callbackUrl: '/auth/login' })}>
      <LogOut className="h-4 w-4" /> Cerrar sesión
    </Button>
  );
}
