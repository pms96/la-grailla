import { Music } from 'lucide-react';
import { SkeletonPulse } from '@/components/ui/animate';
import { Container } from '@/components/layouts/container';

// Mismo marcado estático que la cabecera real (sin datos) para que la
// navegación no dé un salto de layout entre este esqueleto y la página final.
export default function EventosLoading() {
  return (
    <div className="relative">
      <div className="relative overflow-hidden border-b border-border/40">
        <div className="absolute inset-0 hero-gradient opacity-80" />
        <div className="absolute inset-0 texture-noise" />
        <Container size="lg" className="relative">
          <div className="py-14 md:py-20">
            <div className="inline-flex brand-sticker text-xs text-lima border-lima/60 shadow-lima/30 mb-5 gap-1.5">
              <Music className="h-3.5 w-3.5" /> PROGRAMACIÓN
            </div>
            <h1 className="font-display text-4xl md:text-6xl font-bold tracking-tight mb-4 max-w-2xl leading-[0.95]">
              Noches que no se pierden
            </h1>
            <p className="text-muted-foreground text-lg max-w-xl">
              Elige fecha, compra online y llega con el QR listo.
            </p>
          </div>
        </Container>
      </div>

      <Container size="lg">
        <div className="py-10 pb-16 space-y-10">
          <div className="rounded-lg border-2 border-border/50 overflow-hidden">
            <div className="grid md:grid-cols-5">
              <SkeletonPulse className="md:col-span-3 aspect-[16/9] md:aspect-auto md:min-h-[320px] rounded-none" />
              <div className="md:col-span-2 p-6 md:p-8 flex flex-col justify-center gap-4">
                <SkeletonPulse className="h-8 w-3/4" />
                <SkeletonPulse className="h-4 w-1/2" />
                <SkeletonPulse className="h-4 w-2/3" />
                <SkeletonPulse className="h-6 w-24 mt-2" />
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-lg border-2 border-border/50">
                <SkeletonPulse className="aspect-[16/9] w-full rounded-none" />
                <div className="p-5 space-y-3">
                  <SkeletonPulse className="h-5 w-3/4" />
                  <SkeletonPulse className="h-4 w-1/2" />
                  <SkeletonPulse className="h-4 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </div>
  );
}
