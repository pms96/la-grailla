/* Regla de cierre de un diálogo de confirmación (H-011). Antes el diálogo se cerraba SIEMPRE al confirmar, aunque la petición fallase: se perdía el
 * motivo escrito y la persona tenía que volver a empezar. Ahora la acción decide: devolver `false` (o lanzar) deja el diálogo abierto con lo escrito;
 * cualquier otra cosa (`true`, `undefined`: las acciones que no devuelven nada de siempre) lo cierra. */

export type ConfirmAction = () => unknown;

/** Ejecuta la acción confirmada y dice si hay que cerrar el diálogo. Nunca lanza. */
export async function runConfirm(action: ConfirmAction): Promise<boolean> {
  try {
    return (await action()) !== false;
  } catch {
    return false;
  }
}
