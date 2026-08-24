import { Container } from '@/components/layouts/container';
import { Card, CardContent } from '@/components/ui/card';
import { Handshake, Building2, Users, Megaphone } from 'lucide-react';
import { FadeIn, SlideIn } from '@/components/ui/animate';
import SponsorForm from './_components/sponsor-form';

export const metadata = {
  title: 'Patrocinio | La Grailla',
  description: 'Tu marca en la mejor caseta de la feria. Llega a miles de asistentes y sé parte de La Grailla.',
};

export default function SponsorsPage() {
  return (
    <Container size="lg">
      <div className="py-10">
        {/* Layout B2B: propuesta + formulario lado a lado en desktop */}
        <div className="grid lg:grid-cols-12 gap-10 lg:gap-12 items-start">
          <div className="lg:col-span-5 space-y-8">
            <FadeIn>
              <div className="inline-flex brand-sticker text-xs text-lima border-lima/60 shadow-lima/30 mb-4 gap-1.5">
                <Handshake className="h-3.5 w-3.5" /> PARA MARCAS
              </div>
              <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight mb-3 leading-tight">
                Tu marca en la caseta
              </h1>
              <p className="text-muted-foreground text-base leading-relaxed">
                Llegamos a miles de asistentes en vivo. Cuéntanos qué buscas y te respondemos con opciones
                concretas — sin formularios eternos.
              </p>
            </FadeIn>

            <div className="space-y-4">
              <SlideIn from="left">
                <div className="flex gap-3">
                  <div className="p-2.5 rounded-xl bg-primary/10 h-fit">
                    <Megaphone className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-base mb-1">Presencia en eventos</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Banners, menciones, cartelería y comunicaciones alrededor de cada noche.
                    </p>
                  </div>
                </div>
              </SlideIn>
              <SlideIn from="left" delay={0.05}>
                <div className="flex gap-3">
                  <div className="p-2.5 rounded-xl bg-lima/10 h-fit">
                    <Building2 className="h-5 w-5 text-lima" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-base mb-1">Espacios físicos</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Stands y zonas de activación dentro del evento, cara a cara con el público.
                    </p>
                  </div>
                </div>
              </SlideIn>
              <SlideIn from="left" delay={0.1}>
                <div className="flex gap-3">
                  <div className="p-2.5 rounded-xl bg-neon-pink/10 h-fit">
                    <Users className="h-5 w-5 text-neon-pink" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-base mb-1">Audiencia real</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      No es un marketplace anónimo: es la propia productora presentando su público.
                    </p>
                  </div>
                </div>
              </SlideIn>
            </div>
          </div>

          <div className="lg:col-span-7">
            <FadeIn>
              <Card className="border-2 border-border/60 shadow-md">
                <CardContent className="p-6 md:p-8">
                  <h2 className="font-display text-xl font-bold tracking-tight mb-1">Solicitud</h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    Te respondemos por email. Sin compromiso.
                  </p>
                  <SponsorForm />
                </CardContent>
              </Card>
            </FadeIn>
          </div>
        </div>
      </div>
    </Container>
  );
}
