/* Correos de relleno de los pedidos sin comprador con correo (H-101). La taquilla y las invitaciones guardaban `taquilla@lagrailla.local` / `invitacion@lagrailla.local`:
 * un dominio con el nombre de UN cliente, que otro cliente veía en su listado de ventas y en sus CSV. Ahora se guarda un relleno neutro (`@taquilla.local`) y, para lo ya
 * guardado, todo lo que termine en `.local` (no es un correo real, `lib/event-cancellation.ts` ya lo trata así) se ENSEÑA con su canal, no con ese texto. Pura. */

export const TAQUILLA_PLACEHOLDER_EMAIL = 'taquilla@taquilla.local';
export const INVITATION_PLACEHOLDER_EMAIL = 'invitacion@invitacion.local';

/** ¿Es un correo de relleno (no hay un correo real del comprador)? */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return /@[^@\s]+\.local$/i.test((email ?? '').trim());
}

/** Lo que se enseña del correo de un pedido: el real tal cual; el de relleno, el canal («Taquilla», «Invitación»). */
export function displayBuyerEmail(email: string | null | undefined, channel?: string | null): string {
  const value = (email ?? '').trim();
  if (!isPlaceholderEmail(value)) return value;
  const local = value.split('@')[0]?.toLowerCase();
  if (local === 'invitacion' || channel === 'INVITATION') return 'Invitación (sin correo)';
  if (local === 'taquilla' || channel === 'TAQUILLA') return 'Taquilla (sin correo)';
  return 'Sin correo';
}
