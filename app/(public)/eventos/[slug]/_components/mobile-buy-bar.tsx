'use client';

import Link from 'next/link';
import { Ticket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgeWarningGate } from './age-warning-gate';

interface MobileBuyBarProps {
  slug: string;
  minPrice: number | null;
  soldOut: boolean;
  taquillaOnly?: boolean;
  ended?: boolean;
  ageWarningMessage?: string | null;
}

export function MobileBuyBar({ slug, minPrice, soldOut, taquillaOnly = false, ended = false, ageWarningMessage = null }: MobileBuyBarProps) {
  const disabled = soldOut || taquillaOnly || ended;
  return (
    <div
      className="sticky-purchase-bar fixed bottom-0 inset-x-0 z-40 lg:hidden border-t border-border/60 bg-background/95 backdrop-blur-xl shadow-[0_-8px_24px_-8px_rgb(0_0_0_/0.35)] transition-[bottom] duration-200"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      role="region"
      aria-label={ended ? 'Evento finalizado' : taquillaOnly ? 'Entradas solo en taquilla' : soldOut ? 'Entradas agotadas' : 'Comprar entradas'}
    >
      <div className="max-w-[1200px] mx-auto px-4 pt-3 flex items-center gap-3">
        {disabled ? (
          <>
            <div className="min-w-0 flex-1">
              <p className="font-display text-base font-bold leading-tight">
                {ended ? 'Evento finalizado' : taquillaOnly ? 'Solo en taquilla' : 'Sin plazas online'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {ended ? 'Mira la próxima fecha' : taquillaOnly ? 'Cómpralas en el evento' : 'Mira otras fechas o vuelve más tarde'}
              </p>
            </div>
            {!taquillaOnly && (
              <Link href="/eventos" className="shrink-0">
                <Button size="lg" variant="outline" className="gap-2 font-display font-semibold rounded-full h-12 px-5">
                  Otras fechas
                </Button>
              </Link>
            )}
          </>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Desde</p>
              <p className="font-display text-xl font-bold text-primary tabular-nums leading-none">
                {minPrice != null ? `${minPrice.toFixed(2)}€` : '—'}
              </p>
            </div>
            <div className="shrink-0">
              <AgeWarningGate
                href={`/eventos/${slug}/comprar`}
                warningMessage={ageWarningMessage}
                size="lg"
                className="gap-2 font-display font-semibold rounded-full shadow-lg shadow-primary/25 h-12 px-6"
              >
                <Ticket className="h-5 w-5" />
                Comprar
              </AgeWarningGate>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
