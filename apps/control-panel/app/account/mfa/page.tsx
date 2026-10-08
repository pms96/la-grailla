import QRCode from 'qrcode';
import { redirect } from 'next/navigation';
import { requirePreMfa } from '@/lib/guard';
import { startTotpSetup } from '@/lib/services/auth';
import { readSessionToken } from '@/lib/session-cookie';
import { completeTotpAction } from '../../actions/auth';
import { ActionForm } from '../../_components/action-form';

export const dynamic = 'force-dynamic';

export default async function MfaSetupPage() {
  const live = await requirePreMfa();
  if (live.operator.mustChangePassword) redirect('/account/password');
  // Ya activado y con sesión completa: nada que configurar (la pantalla de códigos de recuperación
  // vive en el estado del formulario, así que no se redirige mientras se está mostrando).
  if (live.operator.totpEnabledAt && !live.mfaVerified) redirect('/login/mfa');
  const { secret, uri } = await startTotpSetup(readSessionToken()!).catch(() => ({ secret: '', uri: '' }));
  const qr = uri ? await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' }) : '';
  return (
    <main className="auth">
      <h1>Activa la verificación en dos pasos</h1>
      <p className="muted">Escanea el QR con una app de autenticación (1Password, Google Authenticator, Authy…) y escribe el código que muestra.</p>
      <div className="panel stack">
        {qr && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="qr" src={qr} alt="Código QR para la app de autenticación" width={220} height={220} />
            <details>
              <summary>No puedo escanear el QR</summary>
              <p className="muted">Introduce esta clave a mano:</p>
              <p className="mono" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{secret}</p>
            </details>
          </>
        )}
        <ActionForm action={completeTotpAction} submitLabel="Activar">
          <label>
            Código de la app
            <input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" required maxLength={8} placeholder="123456" />
          </label>
        </ActionForm>
        {live.mfaVerified && <a href="/">Ir al inicio</a>}
      </div>
    </main>
  );
}
