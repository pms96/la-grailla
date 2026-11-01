'use client';

import Link from 'next/link';
import { WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/layouts/container';
import { ReloadButton } from '@/components/reload-button';

/* H-104: pantalla de las páginas públicas cuando falla la carga de datos (BD caída). La página lanza, Next responde 500 y el CDN de Vercel no guarda un 5xx: antes se
 * pintaba este mismo aviso con HTTP 200 y el CDN lo servía a todos los visitantes hasta 90 s después de recuperarse la BD.
 * «Reintentar» recarga con un parámetro nuevo (otra clave de caché del CDN): una recarga normal volvería a pedir la misma URL. */
export default function PublicError() {
  return (
    <Container size="md">
      <div className="py-20 text-center space-y-4" role="alert">
        <WifiOff className="h-14 w-14 text-destructive/60 mx-auto" aria-hidden />
        <h1 className="font-display text-xl font-bold tracking-tight">No hemos podido cargar esta página</h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Fallo de conexión o del servidor — no significa que no haya fechas ni que tu pedido se haya perdido. Prueba de nuevo en unos segundos.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <ReloadButton label="Reintentar" className="gap-2" bustCache />
          <Button asChild variant="outline">
            <Link href="/">Volver al inicio</Link>
          </Button>
        </div>
      </div>
    </Container>
  );
}
