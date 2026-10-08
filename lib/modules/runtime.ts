import { MODULE_KEYS, enabledModules, type LicensePhase, type ModuleKey } from '@grailla/contracts';
import { ownerEnabled } from '@/lib/modules/registry';
import { currentTenant } from '@/lib/tenant/context';
import { isPlatformMode } from '@/lib/tenant/mode';

/* Módulos activos y aviso de licencia desde un Server Component o un handler (Node). NO se importa desde el middleware (usa
 * next/headers); allí se usa lib/modules/registry.ts. */

/** Módulos activos del cliente de la petición. Modo normal (una instalación): todos. Modo plataforma sin cliente: solo el núcleo. */
export function getActiveModules(): ModuleKey[] {
  if (!isPlatformMode()) return [...MODULE_KEYS];
  const ctx = currentTenant();
  return ctx ? enabledModules(ctx.modules) : enabledModules([]);
}

export function isModuleEnabled(key: ModuleKey): boolean {
  return ownerEnabled(key, getActiveModules());
}

export type LicenseNotice = { phase: LicensePhase; nextPhaseChangeAt: number | null };

/** Fase de licencia efectiva de la petición (solo modo plataforma). */
export function getLicenseNotice(): LicenseNotice | null {
  if (!isPlatformMode()) return null;
  const license = currentTenant()?.license;
  return license ? { phase: license.phase, nextPhaseChangeAt: license.nextPhaseChangeAt } : null;
}

/**
 * Para handlers exentos de la fase y del módulo en el middleware pero que hacen más de lo que justifica la exención
 * (p. ej. PATCH /api/admin/orders/{id}: reembolsar y cancelar sí, completar o cambiar el email no). Devuelve true si la
 * licencia o los módulos del cliente actual impiden la acción «completa» (no la de dinero ya en vuelo).
 */
export function isFullAccessRestricted(owner: ModuleKey): boolean {
  if (!isPlatformMode()) return false;
  const phase = getLicenseNotice()?.phase;
  if (phase === 'PANEL_BLOCKED' || phase === 'BLOCKED') return true;
  return !ownerEnabled(owner, getActiveModules());
}
