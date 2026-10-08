export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getLicenseNotice } from '@/lib/modules/runtime';

// Aviso de licencia. El middleware reescribe aquí las rutas bloqueadas (402 el panel, 503 el sitio entero). Con la licencia al día,
// o fuera del modo plataforma, no hay nada que avisar y se vuelve a la web.
export const metadata = { title: 'Servicio no disponible', robots: { index: false, follow: false } };

export default function LicensePage() {
  const notice = getLicenseNotice();
  if (!notice || (notice.phase !== 'PANEL_BLOCKED' && notice.phase !== 'BLOCKED')) redirect('/');
  const panelOnly = notice.phase === 'PANEL_BLOCKED';

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 hero-gradient" />
      <div className="absolute inset-0 texture-noise" />
      <div className="relative max-w-lg mx-auto px-4 py-24 text-center">
        <div className="inline-flex brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mb-8">
          <Lock className="h-4 w-4" />
          {panelOnly ? 'Licencia vencida' : 'Fuera de servicio'}
        </div>
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight mb-4 leading-[0.95]">
          {panelOnly ? 'El panel está bloqueado' : 'Este sitio no está disponible'}
        </h1>
        <p className="text-lg text-muted-foreground mb-10">
          {panelOnly
            ? 'La licencia ha vencido y el acceso al panel de administración está bloqueado hasta que se regularice. La web y las ventas siguen funcionando con normalidad.'
            : 'El sitio está temporalmente fuera de servicio. Si lo administras, contacta con tu proveedor para regularizar la licencia.'}
        </p>
        {panelOnly && (
          <Link href="/">
            <Button size="lg" className="gap-2 font-display font-semibold px-8 h-12 rounded-full shadow-lg shadow-primary/25">
              Ir a la web
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}
