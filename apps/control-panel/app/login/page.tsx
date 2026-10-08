import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/guard';
import { loginAction } from '../actions/auth';
import { ActionForm } from '../_components/action-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const live = await currentSession();
  if (live?.mfaVerified && !live.operator.mustChangePassword) redirect('/');
  return (
    <main className="auth">
      <h1>Acceso al panel</h1>
      <p className="muted">Solo para el proveedor. Después de la contraseña se pide el código de verificación.</p>
      <div className="panel">
        <ActionForm action={loginAction} submitLabel="Continuar">
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required maxLength={254} />
          </label>
          <label>
            Contraseña
            <input name="password" type="password" autoComplete="current-password" required maxLength={200} />
          </label>
        </ActionForm>
      </div>
    </main>
  );
}
