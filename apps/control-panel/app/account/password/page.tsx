import { requirePreMfa } from '@/lib/guard';
import { changePasswordAction } from '../../actions/auth';
import { ActionForm } from '../../_components/action-form';

export const dynamic = 'force-dynamic';

export default async function PasswordPage() {
  const live = await requirePreMfa();
  return (
    <main className="auth">
      <h1>{live.operator.mustChangePassword ? 'Elige tu contraseña' : 'Cambiar contraseña'}</h1>
      <p className="muted">
        {live.operator.mustChangePassword ? 'La contraseña temporal solo sirve para este primer paso. ' : ''}Mínimo 12 caracteres. Al cambiarla se cierran tus otras sesiones.
      </p>
      <div className="panel">
        <ActionForm action={changePasswordAction} submitLabel="Guardar contraseña">
          <label>
            Contraseña actual
            <input name="current" type="password" autoComplete="current-password" required maxLength={200} />
          </label>
          <label>
            Contraseña nueva
            <input name="next" type="password" autoComplete="new-password" required minLength={12} maxLength={72} />
          </label>
          <label>
            Repite la contraseña nueva
            <input name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={72} />
          </label>
        </ActionForm>
      </div>
    </main>
  );
}
