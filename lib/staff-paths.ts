const STAFF_ROLES = ['ADMIN', 'TAQUILLA'];

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
    path.startsWith('/api/access')
  );
}

// Extraída como función pura (sin depender de withAuth/next-auth) para
// poder testear la decisión de autorización sin tener que fabricar un JWT
// firmado de verdad.
export function isAuthorizedStaffRequest(path: string, role: string | undefined | null): boolean {
  if (!isStaffApiPath(path)) return true;
  return STAFF_ROLES.includes(role ?? '');
}
