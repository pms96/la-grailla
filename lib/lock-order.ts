/**
 * Orden fijo en el que una transacción bloquea varias filas (H-181). Cada `update` bloquea su fila hasta el final de la transacción: si dos transacciones tocan las
 * mismas filas en orden distinto (A,B y B,A) se interbloquean y Postgres aborta una con 40P01. Recorriendo SIEMPRE por la misma clave, la segunda espera a la
 * primera y no hay ciclo. No modifica la lista original; el orden entre claves iguales se conserva.
 */
export function sortedByKey<T>(items: Iterable<T>, key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
