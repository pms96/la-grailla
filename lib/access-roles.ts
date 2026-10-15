import { MODULE_KEYS, type ModuleKey } from '@grailla/contracts';
import { prisma } from '@/lib/prisma';
import { CUSTOM_ROLE_PREFIX, presetRoleModules } from '@/lib/modules/access';

/* Parte de servidor de los roles por módulo (lo puro está en lib/modules/access.ts). */

/**
 * Módulos que puede administrar quien tiene este rol. `null` = sin restricción (propietario).
 * Un rol que no existe (clave inventada, rol personalizado borrado) NO da acceso a ningún módulo: ante la duda, cerrado.
 */
export async function resolveAccessModules(accessRole: string | null | undefined): Promise<ModuleKey[] | null> {
  if (accessRole === null || accessRole === undefined || accessRole === '') return null;
  const preset = presetRoleModules(accessRole);
  if (preset) return preset;
  if (accessRole.startsWith(CUSTOM_ROLE_PREFIX)) {
    const role = await prisma.accessRole.findUnique({ where: { id: accessRole.slice(CUSTOM_ROLE_PREFIX.length) }, select: { modules: true } });
    if (role) return role.modules.filter((m): m is ModuleKey => (MODULE_KEYS as readonly string[]).includes(m));
  }
  return [];
}

/** ¿Es un administrador SIN restricción de módulos (propietario)? Solo él gestiona usuarios y roles: si un rol restringido pudiera, se daría más permisos. */
export function isOwnerAdmin(session: { user?: { role?: string; modules?: string[] | null } } | null | undefined): boolean {
  return session?.user?.role === 'ADMIN' && (session.user.modules === null || session.user.modules === undefined);
}

/** Motivo por el que no se puede asignar este rol a un usuario con ese rol de cuenta, o null si se puede. */
export async function accessRoleProblem(accessRole: string | null | undefined, accountRole: string): Promise<string | null> {
  if (accessRole === null || accessRole === undefined) return null;
  if (accountRole !== 'ADMIN') return 'Solo un administrador puede tener un rol por módulos';
  if (presetRoleModules(accessRole)) return null;
  if (accessRole.startsWith(CUSTOM_ROLE_PREFIX) && (await prisma.accessRole.findUnique({ where: { id: accessRole.slice(CUSTOM_ROLE_PREFIX.length) }, select: { id: true } }))) return null;
  return 'Ese rol no existe';
}

/** Cuántos administradores sin restricción hay: el cliente nunca puede quedarse sin ninguno. */
export function countOwners(): Promise<number> {
  return prisma.user.count({ where: { role: 'ADMIN', accessRole: null } });
}

export type UserAccess = {
  role: string;
  accessRole: string | null;
  sessionsValidAfter: Date | null;
  modules: ModuleKey[] | null;
};

/** Lo que la BD dice HOY de un usuario (rol, permisos, revocación), o null si ya no existe. */
export async function loadUserAccess(userId: string): Promise<UserAccess | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, accessRole: true, sessionsValidAfter: true } });
  if (!user) return null;
  return { role: user.role, accessRole: user.accessRole, sessionsValidAfter: user.sessionsValidAfter, modules: await resolveAccessModules(user.accessRole) };
}
