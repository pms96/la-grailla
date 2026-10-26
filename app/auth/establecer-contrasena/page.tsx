import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthLayout } from '@/components/layouts/auth-layout';
import SetPasswordForm from './_components/set-password-form';

// El token va en la URL: que no salga en la cabecera Referer hacia ningún sitio y que ningún buscador indexe la página.
export const metadata: Metadata = { title: 'Crea tu contraseña', referrer: 'no-referrer', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function SetPasswordPage(props: { searchParams: Promise<{ token?: string | string[] }> }) {
  const searchParams = await props.searchParams;
  const token = typeof searchParams.token === 'string' ? searchParams.token : '';
  return (
    <AuthLayout variant="sober" title="Crea tu contraseña" description="Con ella entrarás a la administración de tu web">
      {token ? (
        <SetPasswordForm token={token} />
      ) : (
        <p className="text-sm text-muted-foreground text-center">
          Falta el enlace de la invitación. Abre el correo que recibiste y pulsa el botón, o{' '}
          <Link href="/auth/login" className="underline underline-offset-4">
            ve al acceso
          </Link>{' '}
          si ya tienes contraseña.
        </p>
      )}
    </AuthLayout>
  );
}
