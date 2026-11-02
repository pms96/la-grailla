/* Lectura de JSON de la API del admin desde el navegador (H-176). Las pantallas hacían `fetch(url).then((r) => r.json())` sin mirar `r.ok`: un 401 (sesión caducada), un 423
 * o un 500 devolvían `{ error }`, que se pintaba como una lista vacía y totales «0,00 €», o se tragaba en un `.catch(() => {})`. Quien lee la caja podía dar por vacía
 * (o cerrar) una temporada sobre datos que no habían cargado. Aquí un error HTTP LANZA con el mensaje del servidor (ya en español) o el de reserva, y nunca se devuelve
 * un `{ error }` como si fuera un dato. */

export async function fetchAdminJson<T>(url: string, fallback: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
    throw new Error(message || fallback);
  }
  // H-237: un 200 sin JSON (cuerpo vacío, el HTML de un proxy) o `null` no es un dato: se pintaría como ceros y listas vacías.
  if (body === null) throw new Error(fallback);
  return body as T;
}

/** El mensaje de un error de una petición de borrado/acción ya hecha (`Response` no válida): el del servidor o el de reserva. */
export async function responseError(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
  return message || fallback;
}
