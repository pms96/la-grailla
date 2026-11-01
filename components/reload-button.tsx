'use client';

import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

/** La misma URL con `_r=<instante>`: otra clave de caché para el CDN (una recarga normal pide la misma URL y recibiría la copia guardada). */
export function withCacheBust(href: string, now: number = Date.now()): string {
  const url = new URL(href);
  url.searchParams.set('_r', String(now));
  return url.toString();
}

export function ReloadButton({
  label = 'Reintentar',
  variant = 'default',
  className,
  bustCache = false,
}: {
  label?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  className?: string;
  /** Para páginas que guarda el CDN (H-104): recarga con un parámetro nuevo en la URL para no recibir la copia guardada. */
  bustCache?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={() => (bustCache ? window.location.assign(withCacheBust(window.location.href)) : window.location.reload())}
    >
      <RefreshCw className="h-4 w-4" />
      {label}
    </Button>
  );
}
