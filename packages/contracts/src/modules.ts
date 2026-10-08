// Claves de módulo conocidas por esta versión del contrato. El panel puede
// activar claves que un front antiguo aún no conoce: se ignoran (deny).
export const MODULE_KEYS = ['nucleo', 'tienda', 'entradas', 'contabilidad', 'wallets', 'sponsors'] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

// Siempre activos, estén o no en la lista del snapshot.
export const CORE_MODULES: readonly ModuleKey[] = ['nucleo'];

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/** Módulos activos que este front sabe interpretar (núcleo siempre incluido). */
export function enabledModules(modules: readonly string[]): ModuleKey[] {
  const set = new Set<ModuleKey>(CORE_MODULES);
  for (const m of modules) if (isModuleKey(m)) set.add(m);
  return MODULE_KEYS.filter((k) => set.has(k));
}

export function hasModule(modules: readonly string[], key: ModuleKey): boolean {
  return enabledModules(modules).includes(key);
}
