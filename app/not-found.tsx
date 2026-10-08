import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Ticket, Music, Home } from 'lucide-react';
import { getActiveModules } from '@/lib/modules/runtime';

export default function NotFound() {
  // Sin el módulo Entradas, /eventos tampoco existe: se vuelve al inicio.
  const hasEntradas = getActiveModules().includes('entradas');
  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 hero-gradient" />
      <div className="absolute inset-0 texture-noise" />

      <div className="relative max-w-lg mx-auto px-4 py-24 text-center">
        <div className="inline-flex brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mb-8">
          <Music className="h-4 w-4" />
          404
        </div>
        <h1 className="font-display text-4xl md:text-6xl font-bold tracking-tight mb-4 leading-[0.95]">
          Esta puerta no existe
        </h1>
        <p className="text-lg text-muted-foreground mb-10">
          La página que buscas no está aquí — puede que el enlace haya caducado o esté mal escrito.
        </p>
        <Link href={hasEntradas ? '/eventos' : '/'}>
          <Button size="lg" className="gap-2 font-display font-semibold px-8 h-12 rounded-full shadow-lg shadow-primary/25">
            {hasEntradas ? <Ticket className="h-5 w-5" /> : <Home className="h-5 w-5" />}
            {hasEntradas ? 'Ver Eventos' : 'Volver al inicio'}
          </Button>
        </Link>
      </div>
    </div>
  );
}
