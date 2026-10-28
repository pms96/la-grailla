const STAFF_ROLES = ['ADMIN', 'TAQUILLA'];

/**
 * Ruta con los `%XX` decodificados, para decidir permisos. `new URL('/api/%73can').pathname` conserva `%73`, y Next resuelve después la variante
 * decodificada hasta el handler de `/api/scan`: un middleware que mirara solo la ruta cruda no la reconocería como ruta de personal. Se decide siempre
 * sobre la forma decodificada (más estricta: puede que una ruta decodificada caiga en una zona protegida; nunca al revés). Si la ruta está mal
 * codificada se devuelve tal cual. Pura y edge-safe.
 */
export function decodedPath(path: string): string {
  try {
    const decoded = decodeURIComponent(path);
    return decoded.length > 1 ? decoded.replace(/\/{2,}/g, '/') : decoded;
  } catch {
    return path;
  }
}

// Red de seguridad para las API de staff: cada route handler ya comprueba su
// propia sesión/rol (algunas admiten TAQUILLA además de ADMIN, p.ej.
// /api/admin/scans), así que aquí solo se exige "alguna sesión de staff" en
// vez de replicar el rol exacto de cada endpoint — esto no sustituye esos
// checks inline, solo evita que un endpoint nuevo que se olvide de
// comprobar la sesión quede abierto por defecto.
export function isStaffApiPath(path: string): boolean {
  return (
    path.startsWith('/api/admin') ||
    path.startsWith('/api/taquilla') ||
    path.startsWith('/api/scan') ||
    path.startsWith('/api/access') ||
    // Invitaciones y listas de invitados: solo personal (sus handlers ya lo exigen). Estar aquí hace que el middleware de plataforma lea la sesión y
    // aplique el control por módulo (P1-03); antes solo lo hacía con las rutas de arriba y estas quedaban fuera.
    path.startsWith('/api/invitations') ||
    path.startsWith('/api/guest-lists')
  );
}

// Extraída como función pura (sin depender de withAuth/next-auth) para
// poder testear la decisión de autorización sin tener que fabricar un JWT
// firmado de verdad.
export function isAuthorizedStaffRequest(path: string, role: string | undefined | null): boolean {
  if (!isStaffApiPath(path)) return true;
  return STAFF_ROLES.includes(role ?? '');
}
