import { Container } from '@/components/layouts/container';
import { Card, CardContent } from '@/components/ui/card';
import { Handshake, Building2 } from 'lucide-react';
import { FadeIn, SlideIn } from '@/components/ui/animate';
import SponsorForm from './_components/sponsor-form';

export const metadata = {
  title: 'Patrocinadores | La Grailla',
  description: 'Tu marca en la mejor caseta de la feria. Llega a miles de asistentes y sé parte de La Grailla.',
};

export default function SponsorsPage() {
  return (
    <Container size="lg">
      <div className="py-10">
        <FadeIn>
          <div className="mb-10">
            <div className="inline-flex brand-sticker text-xs text-lima border-lima/60 shadow-lima/30 mb-4">
              🤝 COLABORA CON NOSOTROS
            </div>
            <h1 className="font-display text-3xl md:text-5xl font-bold tracking-tight mb-3">
              Patrocinadores
            </h1>
            <p className="text-muted-foreground text-lg max-w-xl">
              Tu marca en la mejor caseta de la feria. Llega a miles de asistentes y sé parte de La Grailla. 🔥
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-2 gap-6">
          <SlideIn from="left">
            <Card className="h-full border-2 border-border/50 hover:border-primary/30 transition-all">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2.5 rounded-xl bg-primary/10">
                    <Handshake className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-display font-bold text-lg">Patrocinio de Eventos</h3>
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  Tu marca presente en nuestros eventos: banners, menciones en redes, presencia en comunicaciones,
                  cartelería y más. Llega directamente a nuestro público.
                </p>
              </CardContent>
            </Card>
          </SlideIn>

          <SlideIn from="right">
            <Card className="h-full border-2 border-border/50 hover:border-lima/30 transition-all">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2.5 rounded-xl bg-lima/10">
                    <Building2 className="h-6 w-6 text-lima" />
                  </div>
                  <h3 className="font-display font-bold text-lg">Espacios Físicos</h3>
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  Stands, zonas de activación y espacios exclusivos dentro de nuestros eventos.
                  Interactúa directamente con los asistentes.
                </p>
              </CardContent>
            </Card>
          </SlideIn>
        </div>

        <div className="mt-14">
          <FadeIn>
            <h2 className="font-display text-2xl font-bold tracking-tight mb-6">
              ¿Te interesa? Escríbenos 💬
            </h2>
            <SponsorForm />
          </FadeIn>
        </div>
      </div>
    </Container>
  );
}
