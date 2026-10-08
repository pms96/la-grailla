// Un dominio se compara siempre normalizado. Solo ASCII: un dominio con
// caracteres no ASCII debe llegar ya en punycode (xn--...), así no hay dos
// escrituras del mismo dominio ni homógrafos que pasen por iguales.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Devuelve el host normalizado (minúsculas, sin puerto ni punto final) o null si no es un dominio válido. */
export function normalizeHost(input: string): string | null {
  if (typeof input !== 'string') return null;
  let host = input.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  host = host.replace(/:\d{1,5}$/, '');
  return HOST_RE.test(host) ? host : null;
}

export function isNormalizedHost(input: string): boolean {
  return normalizeHost(input) === input;
}

/** Clave bajo la que el panel publica (y el front lee) el snapshot de un dominio. */
export function registryKeyForHost(host: string): string {
  const normalized = normalizeHost(host);
  if (!normalized) throw new Error('dominio no válido para el registro');
  return `h:${normalized}`;
}
