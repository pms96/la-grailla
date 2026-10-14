/* Política de contraseña de la administración de un cliente. Sin dependencias de Node a propósito: la importa también el formulario del
 * navegador (`app/auth/establecer-contrasena`), que no puede cargar `node:crypto`. */

export const MIN_PASSWORD_LENGTH = 10;
/** bcrypt solo usa los primeros 72 bytes: más largo sería una falsa sensación de seguridad. */
export const MAX_PASSWORD_BYTES = 72;

/** Devuelve el motivo en claro si la contraseña no vale, o null si vale. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Escribe una contraseña.';
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return `La contraseña es demasiado larga (máximo ${MAX_PASSWORD_BYTES} bytes).`;
  if (password.trim() === '') return 'La contraseña no puede estar formada solo por espacios.';
  return null;
}
