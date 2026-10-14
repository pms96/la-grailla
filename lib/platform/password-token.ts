import crypto from 'node:crypto';

/* Invitaciones para fijar la contraseña (fase 3 del panel). El front y el panel comparten ESTE fichero para que el token que escribe el
 * panel en la BD de un cliente sea exactamente el que luego busca el front: mismo identificador, mismo hash, misma caducidad.
 *
 * Se guarda en `VerificationToken` (tabla que ya existía y que nada usaba), así que no hay migración. El token viaja en claro SOLO en el
 * enlace; en la BD está su SHA-256. Un volcado de la BD no da enlaces utilizables. */

/** Una invitación vale 72 horas: tiempo de sobra para abrir el correo, y corto si el correo se queda en una bandeja compartida. */
export const PASSWORD_TOKEN_TTL_MS = 72 * 60 * 60_000;

export const PASSWORD_TOKEN_PREFIX = 'pwset:';
export const SET_PASSWORD_PATH = '/auth/establecer-contrasena';

// La política vive aparte (sin `node:crypto`) para que el formulario del navegador pueda importarla; se reexporta para quien ya importaba de aquí.
export { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordProblem } from './password-policy';

/** El email es el de la fila de `User`, tal cual está guardado: así el front encuentra al usuario con una igualdad exacta. */
export const passwordTokenIdentifier = (userEmail: string) => `${PASSWORD_TOKEN_PREFIX}${userEmail}`;

export const hashPasswordToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function newPasswordToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashPasswordToken(token) };
}

export function passwordLink(host: string, token: string): string {
  return `https://${host}${SET_PASSWORD_PATH}?token=${encodeURIComponent(token)}`;
}
