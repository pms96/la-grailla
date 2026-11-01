/**
 * «Solo vale la última petición» (H-097). En una pantalla con filtros, la respuesta tardía de una petición anterior no puede pintar sobre el filtro actual, ni un cursor
 * de un filtro servir para pedir más de otro. Cada petición toma un `token`; `isCurrent(token)` dice si sigue siendo la vigente. `next()` invalida las anteriores.
 */
export function createLatestOnly() {
  let current = 0;
  return {
    /** Empieza una petición nueva: invalida todas las anteriores y devuelve su token. */
    next(): number {
      current += 1;
      return current;
    },
    /** ¿Este token es de la petición más reciente? */
    isCurrent(token: number): boolean {
      return token === current;
    },
  };
}
