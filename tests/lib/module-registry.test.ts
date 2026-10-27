import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REGISTERED_PREFIXES, isDoorPath, isLicenseExempt, ownerEnabled, ownerOfPath } from '@/lib/modules/registry';

/** Rutas públicas de las páginas y route handlers de `app/`, con los grupos `(public)` quitados y los segmentos dinámicos como `x`. */
function appRoutes(): string[] {
  const root = path.join(process.cwd(), 'app');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^(page|route)\.tsx?$/.test(e.name)) {
        const rel = path.relative(root, dir).split(path.sep).filter((seg) => !/^\(.*\)$/.test(seg));
        out.push('/' + rel.map((s) => (/^\[\.{0,3}.*\]$/.test(s) ? 'x' : s)).join('/'));
      }
    }
  };
  walk(root);
  return out.map((r) => (r === '/' ? '/' : r.replace(/\/$/, '')));
}

describe('registro de módulos: default-deny', () => {
  it('TODA página y route handler de app/ tiene un módulo dueño (una ruta nueva sin dueño rompe el CI)', () => {
    const routes = appRoutes();
    expect(routes.length).toBeGreaterThan(100);
    const orphans = routes.filter((r) => ownerOfPath(r) === null);
    expect(orphans, `rutas sin dueño en lib/modules/registry.ts: ${orphans.join(', ')}`).toEqual([]);
  });

  it('una ruta que no existe en el registro no tiene dueño', () => {
    expect(ownerOfPath('/api/nuevo-endpoint')).toBeNull();
    expect(ownerOfPath('/admin/nueva-pantalla')).toBeNull();
    expect(ownerOfPath('/eventos-viejos')).toBeNull();
  });

  it('el prefijo más largo gana y los casan por segmento', () => {
    expect(ownerOfPath('/')).toBe('nucleo');
    expect(ownerOfPath('/admin')).toBe('nucleo');
    expect(ownerOfPath('/admin/')).toBe('nucleo');
    expect(ownerOfPath('/admin/eventos/abc')).toBe('entradas');
    expect(ownerOfPath('/api/admin/sponsors-portal/x/approve')).toBe('sponsors');
    expect(ownerOfPath('/api/admin/config')).toBe('nucleo');
    expect(ownerOfPath('/api/events/foo/minor-authorization')).toBe('entradas');
    expect(ownerOfPath('/tienda/checkout?x=1')).toBe('tienda');
    expect(ownerOfPath('/api/admin/shop-orders/export')).toBe('tienda');
  });

  it('no hay prefijos duplicados con dueños distintos', () => {
    expect(new Set(REGISTERED_PREFIXES).size).toBe(REGISTERED_PREFIXES.length);
  });

  it('núcleo siempre activo; el resto, solo si el cliente lo tiene', () => {
    expect(ownerEnabled('nucleo', [])).toBe(true);
    expect(ownerEnabled('tienda', ['nucleo'])).toBe(false);
    expect(ownerEnabled('tienda', ['nucleo', 'tienda'])).toBe(true);
    expect(ownerEnabled('contabilidad', ['nucleo', 'entradas'])).toBe(false);
  });

  it('wallets exige entradas o tienda', () => {
    expect(ownerEnabled('wallets', ['nucleo', 'wallets'])).toBe(false);
    expect(ownerEnabled('wallets', ['nucleo', 'wallets', 'entradas'])).toBe(true);
    expect(ownerEnabled('wallets', ['nucleo', 'wallets', 'tienda'])).toBe(true);
  });
});

describe('allowlist «nunca bloqueable» (por fase y por módulo)', () => {
  it('webhooks, crons, validación de entradas ya vendidas y acceso', () => {
    for (const p of ['/api/webhooks/stripe', '/api/cron/reconcile-payments', '/api/scan', '/api/access/capacity']) {
      expect(isLicenseExempt(p, 'POST'), p).toBe(true);
    }
  });

  it('la puerta: la pantalla del escáner (solo GET), su lista de eventos y la validación; ni una ruta más', () => {
    expect(isLicenseExempt('/acceso', 'GET')).toBe(true);
    expect(isLicenseExempt('/acceso', 'HEAD')).toBe(true);
    expect(isLicenseExempt('/acceso/', 'GET')).toBe(true);
    expect(isLicenseExempt('/acceso?tab=scan&eventId=x', 'GET')).toBe(true);
    expect(isLicenseExempt('/api/access/events', 'GET')).toBe(true);
    expect(ownerOfPath('/api/access/events')).toBe('entradas');
    expect(isDoorPath('/api/scan', 'POST')).toBe(true);
    for (const [p, m] of [
      ['/acceso', 'POST'],
      ['/acceso/otra', 'GET'],
      ['/acceso-viejo', 'GET'],
      ['/api/events', 'GET'], // la API pública de venta NO se exime: el escáner usa /api/access/events
      ['/api/events/algo', 'GET'],
      ['/api/accesox', 'GET'],
      ['/api/taquilla/sale', 'POST'],
      ['/api/taquilla/print/abc', 'GET'],
      ['/api/invitations', 'GET'],
      ['/api/guest-lists', 'GET'],
      ['/api/admin/scans', 'GET'],
      ['/api/admin/noche', 'GET'],
      ['/admin/noche', 'GET'],
    ] as const) {
      expect(isLicenseExempt(p, m), `${m} ${p}`).toBe(false);
      expect(isDoorPath(p, m), `${m} ${p}`).toBe(false);
    }
  });

  it('el comprador puede ver lo que ya compró, pero NO comprar más', () => {
    expect(isLicenseExempt('/confirmacion/abc', 'GET')).toBe(true);
    expect(isLicenseExempt('/tienda/confirmacion/abc', 'GET')).toBe(true);
    expect(isLicenseExempt('/api/orders/abc', 'GET')).toBe(true);
    expect(isLicenseExempt('/api/shop/orders/abc', 'GET')).toBe(true);
    expect(isLicenseExempt('/api/tickets/abc/pdf-html', 'GET')).toBe(true);
    // El wallet es un módulo de pago aparte: no se exime (un cliente sin él no puede generar pases).
    expect(isLicenseExempt('/api/wallet/apple/abc', 'GET')).toBe(false);
    expect(isLicenseExempt('/api/orders', 'POST')).toBe(false);
    expect(isLicenseExempt('/api/shop/orders', 'POST')).toBe(false);
    expect(isLicenseExempt('/api/taquilla/sale', 'POST')).toBe(false);
    expect(isLicenseExempt('/api/orders/abc/send-tickets', 'POST')).toBe(false);
  });

  // P0-04: el `cancel_url` de la pasarela vuelve a una ruta de COMPRADOR sobre un pedido existente (con su token firmado). No vende nada: solo
  // libera lo que ese pedido reservó, y con la licencia o el módulo cortados ese aforo/stock quedaría retenido. Por eso se exime, y solo el GET.
  it('el abandono de un pedido por su comprador (cancel_url) tiene dueño, se exime de la licencia y solo en GET', () => {
    expect(ownerOfPath('/api/orders/abc/abandon')).toBe('entradas');
    expect(ownerOfPath('/api/shop/orders/abc/abandon')).toBe('tienda');
    expect(isLicenseExempt('/api/orders/abc/abandon', 'GET')).toBe(true);
    expect(isLicenseExempt('/api/shop/orders/abc/abandon', 'GET')).toBe(true);
    expect(isLicenseExempt('/api/orders/abc/abandon', 'POST')).toBe(false);
    expect(isLicenseExempt('/api/orders/abc/abandon/x', 'GET')).toBe(false);
    expect(isLicenseExempt('/api/admin/orders/abc/abandon', 'GET')).toBe(false);
  });

  it('reembolsos de pedidos existentes; el resto del admin, no', () => {
    expect(isLicenseExempt('/api/admin/orders/abc', 'PATCH')).toBe(true);
    expect(isLicenseExempt('/api/admin/orders/abc', 'GET')).toBe(false);
    expect(isLicenseExempt('/api/admin/events', 'POST')).toBe(false);
    expect(isLicenseExempt('/admin', 'GET')).toBe(false);
  });

  it('la pantalla de aviso y el login siguen abiertos', () => {
    expect(isLicenseExempt('/licencia', 'GET')).toBe(true);
    expect(isLicenseExempt('/auth/login', 'GET')).toBe(true);
    expect(isLicenseExempt('/api/auth/session', 'GET')).toBe(true);
  });
});
