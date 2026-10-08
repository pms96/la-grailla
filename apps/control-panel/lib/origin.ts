/** Una petición que modifica datos solo es legítima si su Origin (cuando el navegador lo manda) es este mismo host. */
export function isCrossOriginMutation(method: string, origin: string | null, host: string | null): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false;
  if (origin === null) return false; // sin cabecera (cliente que no es un navegador): la sesión SameSite=Strict y las acciones de Next cubren el resto
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // "null" o basura: se rechaza aquí con un 403 limpio en vez de dejar que reviente dentro de Next
  }
}
