import { describe, it, expect } from 'vitest';
import { MODULE_KEYS } from '@grailla/contracts';
import { PRESET_ROLES, STAFF_SURFACE_PREFIXES, adminLacksModule, modulesKey, pathAllowedForModules, presetRoleModules, validateCustomRole } from '@/lib/modules/access';

// Decisión del dueño (2026-10-15): permisos por módulo dentro de un cliente, con roles predefinidos y otros que crea el cliente con un
// alias eligiendo módulos de la lista. Antes cualquier ADMIN veía y tocaba todo.
describe('Roles predefinidos', () => {
  it('cada rol predefinido solo contiene módulos que existen y ninguno incluye todo', () => {
    for (const [key, role] of Object.entries(PRESET_ROLES)) {
      expect(role.modules.length, key).toBeGreaterThan(0);
      for (const m of role.modules) expect(MODULE_KEYS, `${key}:${m}`).toContain(m);
      expect(role.modules.length, key).toBeLessThan(MODULE_KEYS.length);
    }
  });

  it('presetRoleModules devuelve los módulos del rol, o null si la clave no es de un rol predefinido', () => {
    expect(presetRoleModules('tienda')).toEqual(['tienda']);
    expect(presetRoleModules('inventado')).toBeNull();
  });
});

describe('Qué rutas de administración puede usar un rol restringido', () => {
  const tienda = ['tienda'];

  it('sin restricción (propietario) puede todo', () => {
    expect(pathAllowedForModules('/api/admin/gastos', null)).toBe(true);
    expect(pathAllowedForModules('/admin/usuarios', null)).toBe(true);
  });

  it('solo entra en las rutas de SUS módulos', () => {
    expect(pathAllowedForModules('/admin/productos', tienda)).toBe(true);
    expect(pathAllowedForModules('/api/admin/shop-orders/abc', tienda)).toBe(true);
    expect(pathAllowedForModules('/admin/gastos', tienda)).toBe(false);
    expect(pathAllowedForModules('/api/admin/events', tienda)).toBe(false);
    expect(pathAllowedForModules('/api/admin/sponsors/1', tienda)).toBe(false);
  });

  it('el panel de inicio, la configuración, el cambio de contraseña y las subidas están abiertos a todo administrador', () => {
    for (const p of ['/admin', '/admin/configuracion', '/api/admin/config', '/api/admin/config/test-gateway', '/api/admin/change-password', '/api/admin/upload']) {
      expect(pathAllowedForModules(p, tienda), p).toBe(true);
    }
  });

  it('usuarios y roles son solo del propietario: un rol restringido nunca puede darse más permisos', () => {
    for (const p of ['/admin/usuarios', '/api/admin/users', '/api/admin/users/abc', '/api/admin/roles', '/api/admin/roles/c_1']) {
      expect(pathAllowedForModules(p, ['nucleo', 'tienda']), p).toBe(false);
    }
  });

  it('las rutas del núcleo (apariencia, mensajes) piden el módulo núcleo', () => {
    expect(pathAllowedForModules('/admin/apariencia', tienda)).toBe(false);
    expect(pathAllowedForModules('/admin/apariencia', ['nucleo'])).toBe(true);
    expect(pathAllowedForModules('/api/admin/contact', ['nucleo'])).toBe(true);
  });

  it('una ruta de administración sin dueño se deniega a un rol restringido (default-deny)', () => {
    expect(pathAllowedForModules('/admin/ruta-nueva-sin-dueno', tienda)).toBe(false);
  });

  it('lo que no es administración no se toca (la web pública y las APIs públicas)', () => {
    expect(pathAllowedForModules('/eventos', tienda)).toBe(true);
    expect(pathAllowedForModules('/api/orders', tienda)).toBe(true);
    expect(pathAllowedForModules('/api/webhooks/stripe', tienda)).toBe(true);
  });
});

describe('Clave de permisos (detecta que cambió el rol de alguien con la sesión abierta)', () => {
  it('es estable con el orden y distingue propietario de restringido', () => {
    expect(modulesKey(null)).toBe('*');
    expect(modulesKey(['tienda', 'entradas'])).toBe(modulesKey(['entradas', 'tienda']));
    expect(modulesKey(['tienda'])).not.toBe(modulesKey(['entradas']));
    expect(modulesKey([])).not.toBe('*');
  });
});

describe('Validación de un rol personalizado', () => {
  it('acepta un alias y módulos de la lista', () => {
    expect(validateCustomRole({ name: 'Equipo de tienda y cuentas', modules: ['tienda', 'contabilidad'] })).toBeNull();
  });

  it('rechaza alias vacío o larguísimo, sin módulos, o con módulos que no existen', () => {
    expect(validateCustomRole({ name: '  ', modules: ['tienda'] })).not.toBeNull();
    expect(validateCustomRole({ name: 'x'.repeat(41), modules: ['tienda'] })).not.toBeNull();
    expect(validateCustomRole({ name: 'Vacío', modules: [] })).not.toBeNull();
    expect(validateCustomRole({ name: 'Raro', modules: ['tienda', 'inventado'] })).not.toBeNull();
  });

  it('el alias no puede coincidir con el de un rol predefinido', () => {
    expect(validateCustomRole({ name: PRESET_ROLES.tienda.label, modules: ['tienda'] })).not.toBeNull();
  });
});

/* P1-03: las superficies de PERSONAL fuera de /admin (la puerta, la taquilla, las invitaciones, las listas de invitados, el escáner) también
 * pertenecen a un módulo. Antes solo se restringía /admin y /api/admin, y un «Gestor de tienda» vendía en taquilla y emitía invitaciones. */
describe('Matriz rol × superficie de personal (P1-03)', () => {
  const STAFF_PATHS = ['/acceso', '/api/taquilla/sale', '/api/taquilla/print-settings', '/api/taquilla/print/abc', '/api/invitations', '/api/invitations/abc', '/api/guest-lists', '/api/scan', '/api/access/events', '/api/access/capacity'];

  it('el propietario (sin restricción) entra en todas', () => {
    for (const p of STAFF_PATHS) expect(pathAllowedForModules(p, null), p).toBe(true);
  });

  it.each([
    ['entradas', ['entradas', 'wallets']],
    ['con entradas entre varios', ['tienda', 'entradas']],
  ])('un rol con Entradas (%s) entra en todas', (_label, mods) => {
    for (const p of STAFF_PATHS) expect(pathAllowedForModules(p, mods), p).toBe(true);
  });

  it.each([
    ['tienda', ['tienda']],
    ['contabilidad', ['contabilidad']],
    ['sponsors', ['sponsors']],
    ['contenido (núcleo)', ['nucleo']],
    ['sin Entradas, con casi todo lo demás', ['nucleo', 'tienda', 'contabilidad', 'sponsors', 'wallets']],
  ])('un rol SIN Entradas (%s) no entra en ninguna: no vende en taquilla, no emite invitaciones, no escanea', (_label, mods) => {
    for (const p of STAFF_PATHS) expect(pathAllowedForModules(p, mods), p).toBe(false);
  });

  it('las APIs públicas con el mismo dueño siguen abiertas (las usa el comprador, no el personal)', () => {
    for (const p of ['/api/orders', '/api/events', '/api/tickets/abc/pdf-html', '/api/wallet/apple/abc', '/api/queue/join']) {
      expect(pathAllowedForModules(p, ['tienda']), p).toBe(true);
    }
  });

  it('un prefijo parecido no se cuela (ni se bloquea): /acceso-publico no es /acceso', () => {
    expect(pathAllowedForModules('/accesorios', ['tienda'])).toBe(true);
    expect(pathAllowedForModules('/api/scanner-info', ['tienda'])).toBe(true);
    expect(pathAllowedForModules('/acceso/', ['tienda'])).toBe(false); // la barra final no es una vía de escape
  });

  it('toda superficie de personal tiene un dueño en el registro (si no, se denegaría a todo rol restringido)', async () => {
    const { ownerOfPath } = await import('@/lib/modules/registry');
    for (const prefix of STAFF_SURFACE_PREFIXES) expect(ownerOfPath(prefix), prefix).toBe('entradas');
  });
});

describe('adminLacksModule (comprobación en los handlers, P1-03)', () => {
  it('un ADMIN restringido sin el módulo, sí; con el módulo, no', () => {
    expect(adminLacksModule({ role: 'ADMIN', modules: ['tienda'] }, 'entradas')).toBe(true);
    expect(adminLacksModule({ role: 'ADMIN', modules: ['tienda', 'entradas'] }, 'entradas')).toBe(false);
    expect(adminLacksModule({ role: 'ADMIN', modules: [] }, 'entradas')).toBe(true);
  });
  it('el propietario (ADMIN con modules nulo) nunca carece de un módulo', () => {
    expect(adminLacksModule({ role: 'ADMIN', modules: null }, 'entradas')).toBe(false);
    expect(adminLacksModule({ role: 'ADMIN' }, 'sponsors')).toBe(false);
  });
  it('el personal de puerta (TAQUILLA) trae modules nulo y no tiene rol por módulos: no se le aplica, venga lo que venga', () => {
    expect(adminLacksModule({ role: 'TAQUILLA', modules: null }, 'entradas')).toBe(false);
    expect(adminLacksModule({ role: 'TAQUILLA', modules: ['tienda'] }, 'entradas')).toBe(false);
  });
  it('sin sesión no hay nada que restringir aquí (de eso se ocupa la comprobación de rol)', () => {
    expect(adminLacksModule(null, 'entradas')).toBe(false);
    expect(adminLacksModule(undefined, 'entradas')).toBe(false);
  });
});
