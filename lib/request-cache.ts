import * as React from 'react';

/**
 * Memoiza una función asíncrona SIN argumentos durante una petición (render de Server Components). `React.cache` solo existe en el React
 * de Next (canary); en los tests, scripts y route handlers es undefined y la función se llama directamente. Nunca guarda nada entre
 * peticiones, así que no puede mezclar clientes.
 */
export function perRequest<T>(fn: () => Promise<T>): () => Promise<T> {
  const cache = (React as unknown as { cache?: <F extends () => Promise<T>>(f: F) => F }).cache;
  return cache ? cache(fn) : fn;
}
