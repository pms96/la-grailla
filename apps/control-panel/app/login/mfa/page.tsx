import { redirect } from 'next/navigation';
import { requirePreMfa } from '@/lib/guard';
import { mfaAction } from '../../actions/auth';
import { ActionForm } from '../../_components/action-form';

export const dynamic = 'force-dynamic';

export default async function MfaPage() {
  const live = await requirePreMfa();
  if (live.mfaVerified) redirect('/');
  if (live.operator.mustChangePassword) redirect('/account/password');
  if (!live.operator.totpEnabledAt) redirect('/account/mfa');
  return (
    <main className="auth">
      <h1>Verificación en dos pasos</h1>
      <p className="muted">Introduce el código de 6 dígitos de tu app de autenticación. Si has perdido el móvil, usa uno de tus códigos de recuperación.</p>
      <div className="panel">
        <ActionForm action={mfaAction} submitLabel="Entrar">
          <label>
            Código
            <input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={16} placeholder="123456" />
          </label>
        </ActionForm>
      </div>
    </main>
  );
}
