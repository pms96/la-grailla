/* H-225: una pantalla que relanza su carga (filtros que cambian, un buscador con debounce, «Reintentar») solo debe hacer caso a la respuesta de la ÚLTIMA petición lanzada. Sin esto una
 * respuesta lenta de la selección anterior llega la última y pisa los datos de la actual, o su error tapa los buenos.
 *
 *   const latest = useRef(createLatest());
 *   const id = latest.current.next();
 *   fetchAdminJson(...).then((d) => { if (!latest.current.isCurrent(id)) return; setX(d); }) */

export function createLatest() {
  let current = 0;
  return {
    /** Registra una petición nueva y devuelve su número. */
    next: () => ++current,
    /** ¿Sigue siendo `id` la última petición lanzada? */
    isCurrent: (id: number) => id === current,
  };
}
