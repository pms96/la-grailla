'use client';

import { useState } from 'react';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Dirección del mapa embebido de Google para una consulta de texto. Pura para poder probarla sin navegador. */
export function mapEmbedUrl(query: string): string {
  return `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=15&output=embed`;
}

// El iframe de Google arrastra ~500 KB de scripts aunque lleve `loading="lazy"` (Lighthouse lo carga igual) y es lo que más baja la nota de
// esta página. Hasta que el visitante lo pide se pinta un bloque del mismo alto (320 px: sin CLS) y no se contacta con Google, que además
// evita enviarle datos del visitante sin que lo haya querido. «Cómo llegar» queda fuera, siempre disponible, para quien solo quiere la ruta.
export function MapFacade({ query, venue }: { query: string; venue: string }) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <iframe
        title={`Mapa de ${venue}`}
        src={mapEmbedUrl(query)}
        width="100%"
        height="320"
        referrerPolicy="no-referrer-when-downgrade"
        style={{ border: 0, display: 'block' }}
      />
    );
  }

  return (
    <div className="flex h-80 flex-col items-center justify-center gap-3 px-6 text-center">
      <MapPin className="h-8 w-8 text-primary" aria-hidden />
      <p className="max-w-xs text-sm text-muted-foreground">El mapa se carga desde Google Maps cuando lo pides.</p>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Ver mapa
      </Button>
    </div>
  );
}
