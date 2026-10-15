import { MODULE_KEYS, type ModuleKey } from '@grailla/contracts';
import { ownerOfPath } from '@/lib/modules/registry';

/* Permisos por módulo DENTRO de un cliente. Es puro y edge-safe (lo usa el middleware).
 *
 * Hasta ahora cualquier usuario ADMIN veía y tocaba todos los módulos del cliente. Ahora un usuario puede tener un ROL que lo limita a
 * unos módulos: uno predefinido (esta lista) o uno personalizado con un alias que crea el propio cliente eligiendo módulos
 * (tabla AccessRole). `null` = sin restricción (propietario, como siempre: así las cuentas que ya existen no cambian).
 *
 * Un rol restringido NUNCA puede gestionar usuarios ni roles: si pudiera, se daría más permisos a sí mismo. */

export type PresetRoleKey = 'entradas' | 'tienda' | 'contabilidad' | 'sponsors' | 'contenido';

export const PRESET_ROLES: Readonly<Record<PresetRoleKey, { label: string; description: string; modules: ModuleKey[] }>> = {
  entradas: { label: 'Gestor de entradas', description: 'Eventos, entradas, ventas, aforo y escáner (y Wallets).', modules: ['entradas', 'wallets'] },
  tienda: { label: 'Gestor de tienda', description: 'Productos y pedidos de la tienda.', modules: ['tienda'] },
  contabilidad: { label: 'Contable', description: 'Compras, gastos e ingresos.', modules: ['contabilidad'] },
  sponsors: { label: 'Gestor de sponsors', description: 'Portal de sponsors y su pipeline.', modules: ['sponsors'] },
  contenido: { label: 'Contenido y mensajes', description: 'Apariencia de la web y bandeja de mensajes.', modules: ['nucleo'] },
};

/** Módulos de un rol predefinido, o null si la clave no es de ninguno. */
export function presetRoleModules(key: string): ModuleKey[] | null {
  return Object.prototype.hasOwnProperty.call(PRESET_ROLES, key) ? [...PRESET_ROLES[key as PresetRoleKey].modules] : null;
}

/** Prefijos de un rol personalizado en `User.accessRole`: `c_<id del AccessRole>`. */
export const CUSTOM_ROLE_PREFIX = 'c_';

/** Clave estable de un conjunto de permisos (`*` = propietario): permite detectar que cambió el rol de alguien con la sesión abierta. */
export function modulesKey(modules: readonly string[] | null): string {
  return modules === null ? '*' : `m:${[...modules].sort().join(',')}`;
}

const prefixMatch = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Solo el propietario: quien gestiona usuarios y roles podría darse más permisos. */
const OWNER_ONLY = ['/admin/usuarios', '/api/admin/users', '/admin/roles', '/api/admin/roles'];
/** Abiertas a todo administrador: el inicio, la configuración (que filtra por módulo clave a clave), la contraseña propia y las subidas. */
const OPEN_TO_ADMINS = ['/admin/configuracion', '/api/admin/config', '/api/admin/change-password', '/api/admin/upload'];

/**
 * ¿Puede un administrador con estos módulos usar esta ruta? `null` = propietario. Solo restringe la zona de administración
 * (`/admin` y `/api/admin`); la web pública y las APIs públicas no cambian. Una ruta de administración sin dueño se deniega.
 */
export function pathAllowedForModules(path: string, modules: readonly string[] | null): boolean {
  if (modules === null) return true;
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (!(p === '/admin' || p.startsWith('/admin/') || p === '/api/admin' || p.startsWith('/api/admin/'))) return true;
  if (p === '/admin') return true;
  if (OWNER_ONLY.some((o) => prefixMatch(p, o))) return false;
  if (OPEN_TO_ADMINS.some((o) => prefixMatch(p, o))) return true;
  const owner = ownerOfPath(p);
  return owner !== null && modules.includes(owner);
}

const NAME_MAX = 40;

/** Motivo por el que un rol personalizado no es válido, o null si lo es. */
export function validateCustomRole(input: { name: string; modules: readonly string[] }): string | null {
  const name = input.name.trim();
  if (name.length === 0) return 'El rol necesita un nombre';
  if (name.length > NAME_MAX) return `El nombre no puede pasar de ${NAME_MAX} caracteres`;
  if (Object.values(PRESET_ROLES).some((r) => r.label.toLowerCase() === name.toLowerCase())) return 'Ese nombre ya lo usa un rol predefinido';
  if (input.modules.length === 0) return 'Elige al menos un módulo';
  const unknown = input.modules.filter((m) => !(MODULE_KEYS as readonly string[]).includes(m));
  if (unknown.length > 0) return `Módulos desconocidos: ${unknown.join(', ')}`;
  return null;
}
