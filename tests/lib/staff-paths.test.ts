import { describe, it, expect } from 'vitest';
import { decodedPath, isAuthorizedStaffRequest, isStaffApiPath } from '@/lib/staff-paths';
import { pathAllowedForModules } from '@/lib/modules/access';

describe('decodedPath: los permisos se deciden sobre la ruta decodificada', () => {
  it('decodifica los %XX (new URL los conserva y Next resuelve después la variante decodificada)', () => {
    expect(new URL('http://x/api/%73can').pathname).toBe('/api/%73can');
    expect(decodedPath('/api/%73can')).toBe('/api/scan');
    expect(decodedPath('/%61dmin/usuarios')).toBe('/admin/usuarios');
    expect(decodedPath('/%61cceso')).toBe('/acceso');
    expect(decodedPath('/api%2Fscan')).toBe('/api/scan');
  });

  it('una ruta normal queda igual, y una mal codificada se devuelve tal cual (nunca lanza)', () => {
    expect(decodedPath('/api/scan')).toBe('/api/scan');
    expect(decodedPath('/')).toBe('/');
    expect(decodedPath('/api/%E0%A4%A')).toBe('/api/%E0%A4%A');
  });

  it('las variantes codificadas caen en la MISMA decisión que la ruta normal', () => {
    for (const [raw, normal] of [['/api/%73can', '/api/scan'], ['/api/taquilla/%73ale', '/api/taquilla/sale'], ['/api/%69nvitations', '/api/invitations']]) {
      expect(isStaffApiPath(decodedPath(raw)), raw).toBe(isStaffApiPath(normal));
      expect(isStaffApiPath(decodedPath(raw)), raw).toBe(true);
      expect(isAuthorizedStaffRequest(decodedPath(raw), undefined), raw).toBe(false);
      expect(pathAllowedForModules(decodedPath(raw), ['tienda']), raw).toBe(false);
    }
  });
});

describe('isStaffApiPath', () => {
  it('incluye invitaciones y listas de invitados (solo personal)', () => {
    for (const p of ['/api/invitations', '/api/invitations/abc', '/api/guest-lists', '/api/taquilla/sale', '/api/scan', '/api/access/events', '/api/admin/users']) {
      expect(isStaffApiPath(p), p).toBe(true);
    }
  });
  it('las APIs públicas no', () => {
    for (const p of ['/api/orders', '/api/events', '/api/queue/join', '/api/shop/orders', '/api/webhooks/stripe']) expect(isStaffApiPath(p), p).toBe(false);
  });
});
