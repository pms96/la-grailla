import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { getOnboardingNotice, onboardingNoticeText } from '@/lib/onboarding';

/* Aviso de datos pendientes para un cliente nuevo (modo plataforma). No se muestra en la instalación única ni al cliente legacy. */
export default async function OnboardingNotice() {
  const missing = await getOnboardingNotice().catch(() => []);
  if (missing.length === 0) return null;
  return (
    <div role="status" className="mb-6 flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <p>
        {onboardingNoticeText(missing)}{' '}
        <Link href="/admin/configuracion" className="font-medium underline underline-offset-2 hover:text-primary">
          Ir a Configuración
        </Link>
      </p>
    </div>
  );
}
