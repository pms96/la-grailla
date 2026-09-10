import { Hourglass } from 'lucide-react';
import { Container } from '@/components/layouts/container';

// Mismo aspecto que el estado CHECKING de WaitingRoomGate, para que no haya
// salto perceptible entre este esqueleto (mientras el servidor resuelve el
// evento) y el primer render real del componente cliente.
export default function ComprarLoading() {
  return (
    <Container size="md">
      <div className="py-8">
        <div
          className="relative overflow-hidden rounded-lg border border-border bg-card hero-gradient texture-noise p-8 md:p-12 text-center space-y-4"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-lima/10 blur-3xl" />
          <Hourglass className="relative h-8 w-8 text-primary mx-auto animate-pulse" aria-hidden />
          <div className="relative space-y-2">
            <h1 className="font-display text-xl font-bold tracking-tight">Cargando…</h1>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">Preparando la compra de entradas.</p>
          </div>
        </div>
      </div>
    </Container>
  );
}
