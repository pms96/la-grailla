/**
 * Mezcla dos listas por turnos (a0, b0, a1, b1…); cuando una se acaba, sigue con lo que queda de la otra. Mantiene el orden interno de cada una.
 *
 * Lo usa el cron de conciliación: la cola justa solo ordena DENTRO de cada lista (entradas, tienda), y el bucle se corta por tiempo en el orden en que
 * se concatenan. Si las entradas iban siempre delante, una pasada que agotara su presupuesto con ellas dejaba a los pedidos de tienda (ya pagados y sin
 * webhook) sin examinar pasada tras pasada. Intercalarlas reparte el tiempo disponible entre las dos.
 */
export function interleave<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  const longest = Math.max(a.length, b.length);
  for (let i = 0; i < longest; i += 1) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}
