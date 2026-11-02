/* Lectura de `GET /api/admin/config` en la pantalla de Configuración (H-096). Antes: `.catch(() => {})`, y con un `{ error }` (o un 401/500) el `.forEach` lanzaba y se
 * tragaba: el formulario salía VACÍO, sin aviso, con los valores por defecto aparentes («0», «10»), y el administrador podía creer que eran los suyos y guardar. */

export type ConfigRow = { key: string; value: string; label?: string; group?: string };

/** La respuesta de la API: la lista de filas, o el error en español. Nunca una lista vacía «de mentira». */
export function readConfigPayload(ok: boolean, data: unknown): { configs: ConfigRow[] } | { error: string } {
  if (ok && Array.isArray(data)) {
    return { configs: data.filter((c): c is ConfigRow => !!c && typeof c === 'object' && typeof (c as ConfigRow).key === 'string').map((c) => ({ ...c, value: typeof c.value === 'string' ? c.value : '' })) };
  }
  const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : '';
  // La pantalla ya pone «No se ha podido cargar la configuración.» de título (H-167): este texto lo completa, no lo repite.
  return { error: message || 'El servidor no ha devuelto la configuración. Prueba de nuevo en un momento.' };
}
