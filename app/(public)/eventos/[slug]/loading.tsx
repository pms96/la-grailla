import { SkeletonPulse } from '@/components/ui/animate';
import { Container } from '@/components/layouts/container';

// Misma estructura de dos columnas que la página real (hero + tickets +
// cards de contenido) para que la navegación no salte al llegar los datos.
export default function EventoDetailLoading() {
  return (
    <>
      <div className="relative overflow-hidden min-h-[42vh] md:min-h-[48vh] flex items-end">
        <div className="absolute inset-0 hero-gradient" />
        <Container size="lg" className="relative w-full pb-8 pt-28">
          <SkeletonPulse className="h-10 md:h-14 w-2/3 max-w-lg mb-4" />
          <div className="flex flex-wrap gap-3 mt-4">
            <SkeletonPulse className="h-6 w-28 rounded-full" />
            <SkeletonPulse className="h-6 w-32 rounded-full" />
            <SkeletonPulse className="h-6 w-24 rounded-full" />
          </div>
        </Container>
      </div>

      <Container size="lg">
        <div className="py-8 pb-28 lg:pb-8">
          <div className="grid lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="lg:hidden rounded-lg border p-6 space-y-4">
                <SkeletonPulse className="h-5 w-32" />
                <SkeletonPulse className="h-16 w-full rounded-lg" />
                <SkeletonPulse className="h-11 w-full rounded-full" />
              </div>
              <div className="rounded-lg border p-6 space-y-3">
                <SkeletonPulse className="h-4 w-full" />
                <SkeletonPulse className="h-4 w-5/6" />
                <SkeletonPulse className="h-4 w-2/3" />
              </div>
              <div className="rounded-lg border p-6 space-y-3">
                <SkeletonPulse className="h-5 w-40" />
                <SkeletonPulse className="h-4 w-full" />
                <SkeletonPulse className="h-4 w-1/2" />
              </div>
            </div>

            <div className="hidden lg:block lg:col-span-1">
              <div className="sticky top-24 rounded-lg border p-6 space-y-4">
                <SkeletonPulse className="h-5 w-32" />
                <SkeletonPulse className="h-16 w-full rounded-lg" />
                <SkeletonPulse className="h-11 w-full rounded-full" />
              </div>
            </div>
          </div>
        </div>
      </Container>
    </>
  );
}
