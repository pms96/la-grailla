// AUDIT: SEC-04 — el middleware de Next solo cubría /admin y /acceso (páginas),
// no las API de staff. Antes de este fix, un endpoint nuevo bajo /api/admin,
// /api/taquilla, /api/scan o /api/access que se olvidara de comprobar la sesión
// quedaba abierto por defecto — solo lo protegía el check inline de cada route
// handler, sin ninguna red de seguridad a nivel de plataforma.
//
// middleware.ts ahora exporta isAuthorizedStaffRequest como función pura para
// poder testear la decisión sin depender de withAuth/next-auth (que exige un JWT
// firmado de verdad y no es practicable de invocar en un test unitario).
import { describe, it, expect } from 'vitest';
import { isStaffApiPath, isAuthorizedStaffRequest } from '@/middleware';

describe('AUDIT — matcher y autorización de las API de staff en middleware.ts', () => {
  it('identifica las 4 familias de rutas de staff', () => {
    expect(isStaffApiPath('/api/admin/users')).toBe(true);
    expect(isStaffApiPath('/api/taquilla/sale')).toBe(true);
    expect(isStaffApiPath('/api/scan')).toBe(true);
    expect(isStaffApiPath('/api/access/capacity')).toBe(true);
  });

  it('no afecta a rutas públicas', () => {
    expect(isStaffApiPath('/api/orders')).toBe(false);
    expect(isStaffApiPath('/api/tickets/abc/pdf-html')).toBe(false);
    expect(isStaffApiPath('/api/shop/orders')).toBe(false);
    expect(isStaffApiPath('/')).toBe(false);
  });

  it('rechaza una API de staff sin sesión', () => {
    expect(isAuthorizedStaffRequest('/api/admin/users', undefined)).toBe(false);
    expect(isAuthorizedStaffRequest('/api/scan', null)).toBe(false);
  });

  it('rechaza una API de staff con un rol que no es de staff', () => {
    expect(isAuthorizedStaffRequest('/api/admin/users', 'USER')).toBe(false);
  });

  it('acepta ADMIN y TAQUILLA en las 4 familias de rutas', () => {
    for (const path of ['/api/admin/users', '/api/taquilla/sale', '/api/scan', '/api/access/capacity']) {
      expect(isAuthorizedStaffRequest(path, 'ADMIN')).toBe(true);
      expect(isAuthorizedStaffRequest(path, 'TAQUILLA')).toBe(true);
    }
  });

  it('deja pasar rutas no cubiertas independientemente del rol (las gestiona el check inline)', () => {
    expect(isAuthorizedStaffRequest('/api/orders', undefined)).toBe(true);
    expect(isAuthorizedStaffRequest('/api/orders', 'USER')).toBe(true);
  });
});
