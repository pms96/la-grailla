import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { STAFF_SURFACE_PREFIXES } from '@/lib/modules/access';

/* P1-03: cada API que comprueba una sesión de PERSONAL tiene que estar clasificada. Si cuelga de /api/admin, el control por módulo ya la cubre. Si no,
 * tiene que ser una superficie de personal (STAFF_SURFACE_PREFIXES, restringida por módulo) o estar en la lista de excepciones de abajo con su motivo.
 * Una API de staff nueva fuera de /api/admin que se olvide de esto rompe la CI en vez de quedar abierta a cualquier rol restringido.
 *
 * H-154: detectar «esta ruta comprueba personal» por el nombre del helper deja pasar una ruta nueva con un helper que la regex no conoce (`requireTaquilla`…).
 * Por eso el test está INVERTIDO: TODA ruta fuera de /api/admin tiene que estar clasificada por su nombre (superficie de personal, pública con personal opcional o
 * pública sin más, con motivo). Una ruta nueva sin clasificar rompe la CI, comprobe lo que comprobe por dentro. */

const API_DIR = path.join(process.cwd(), 'app', 'api');
// También las rutas que dejan pasar a «una sesión de personal» por un helper de lib/ (allow…Access, requireStaff): no llevan `getServerSession` en su fuente.
const STAFF_CHECK = /getServerSession|isStaffSession|isAdminSession|allow(Order|ShopOrder|Ticket|Sponsor)Access|requireStaff/;

/** APIs públicas que miran la sesión solo para dar MÁS al personal (o para ceder el paso al comprador con su token). No son superficies de personal. */
const PUBLIC_WITH_OPTIONAL_STAFF: Record<string, string> = {
  '/api/events': 'listado público de eventos; con sesión de personal añade borradores (solo lectura)',
  '/api/events/[slug]': 'ficha pública del evento; con sesión de personal ve también los no publicados',
  '/api/events/[slug]/minor-authorization': 'PDF público de autorización de menores; con ADMIN con Entradas se descarga también el de un borrador (H-059)',
  '/api/orders/[orderId]/send-tickets': 'reenvío de entradas: lo usa el comprador con su token o el personal desde el admin',
  // Token del comprador o del sponsor, o personal CON el módulo dueño: el fallback de personal es module-aware (isStaffSessionFor / isAdminSessionFor).
  '/api/orders/[orderId]': 'confirmación del comprador (token) o personal de Entradas',
  '/api/shop/orders/[orderId]': 'confirmación del comprador (token) o personal de Tienda',
  '/api/shop/orders/[orderId]/send-email': 'reenvío del email de la tienda: token o personal de Tienda',
  '/api/tickets/[orderId]/pdf-html': 'PDF imprimible: token del comprador o personal de Entradas',
  '/api/wallet/apple/[ticketId]': 'pase de Wallet: token del comprador o personal de Entradas',
  '/api/wallet/google/[ticketId]': 'pase de Wallet: token del comprador o personal de Entradas',
  '/api/sponsors/portal/[sponsorId]': 'portal del sponsor: token o ADMIN con Sponsors',
  '/api/sponsors/portal/[sponsorId]/datos': 'portal del sponsor: token o ADMIN con Sponsors',
  '/api/sponsors/portal/[sponsorId]/logo': 'portal del sponsor: token o ADMIN con Sponsors',
  '/api/sponsors/portal/[sponsorId]/logo/upload-token': 'portal del sponsor: token o ADMIN con Sponsors',
  '/api/sponsors/portal/[sponsorId]/creatividad': 'portal del sponsor: token o ADMIN con Sponsors',
  '/api/sponsors/portal/[sponsorId]/assets/[assetId]': 'portal del sponsor: token o ADMIN con Sponsors',
};

/** APIs sin sesión de personal: públicas, con credencial propia (token, secreto de cron, firma de webhook) o cerradas. La ruta nueva se añade AQUÍ a propósito. */
const PUBLIC_ROUTES: Record<string, string> = {
  '/api/auth/[...nextauth]': 'NextAuth (inicio de sesión, sesión, cierre)',
  '/api/auth/set-password': 'fijar la contraseña con el token de una invitación del panel',
  '/api/contact': 'formulario público de contacto (límite de ritmo y honeypot)',
  '/api/cron/cleanup-waiting-room': 'cron: protegido con CRON_SECRET',
  '/api/cron/reconcile-gateway': 'cron: protegido con CRON_SECRET',
  '/api/cron/reconcile-payments': 'cron: protegido con CRON_SECRET',
  '/api/health': 'sonda de salud pública (sin datos)',
  '/api/orders': 'compra de entradas por el comprador (checkout invitado)',
  '/api/orders/[orderId]/abandon': 'abandono por el comprador con el token firmado de su pedido',
  '/api/products': 'catálogo público de la tienda',
  '/api/queue/join': 'sala de espera: el comprador pide turno',
  '/api/queue/status': 'sala de espera: el comprador consulta su turno',
  '/api/shop/orders': 'compra de la tienda por el comprador (checkout invitado)',
  '/api/shop/orders/[orderId]/abandon': 'abandono por el comprador con el token firmado de su pedido',
  '/api/signup': 'registro público cerrado (responde 404)',
  '/api/sponsors': 'formulario público de sponsors',
  '/api/sponsors/tiers': 'tipos y precios de patrocinio, públicos a propósito',
  '/api/wallet/status': 'disponibilidad pública de wallets (sin datos)',
  '/api/webhooks/[provider]': 'webhook de la pasarela, con verificación de firma',
  '/api/webhooks/stripe': 'webhook de Stripe, con verificación de firma',
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

const toApiPath = (file: string) => '/api/' + path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/');
const prefixMatch = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}/`);

describe('Clasificación de las APIs de personal fuera de /api/admin (P1-03)', () => {
  const staffRoutes = routeFiles(API_DIR)
    .filter((f) => STAFF_CHECK.test(fs.readFileSync(f, 'utf8')))
    .map(toApiPath)
    .filter((p) => !prefixMatch(p, '/api/admin'));

  it('se encuentran las APIs de personal conocidas (el test no está vacío)', () => {
    expect(staffRoutes.length).toBeGreaterThanOrEqual(6);
    expect(staffRoutes).toContain('/api/taquilla/sale');
    expect(staffRoutes).toContain('/api/scan');
  });

  it('cada una es una superficie de personal restringida por módulo, o una excepción documentada', () => {
    const sinClasificar = staffRoutes.filter((p) => !STAFF_SURFACE_PREFIXES.some((s) => prefixMatch(p, s)) && !(p in PUBLIC_WITH_OPTIONAL_STAFF));
    expect(sinClasificar, 'Estas APIs comprueban sesión de personal pero no están en STAFF_SURFACE_PREFIXES (lib/modules/access.ts) ni en las excepciones').toEqual([]);
  });

  it('las excepciones siguen existiendo (si una API desaparece, se quita de la lista)', () => {
    const all = new Set(routeFiles(API_DIR).map(toApiPath));
    for (const p of Object.keys(PUBLIC_WITH_OPTIONAL_STAFF)) expect(all, p).toContain(p);
  });

  it('H-154: TODA ruta fuera de /api/admin está clasificada por nombre (personal, pública con personal opcional o pública), sin depender del helper que use', () => {
    const outside = routeFiles(API_DIR).map(toApiPath).filter((p) => !prefixMatch(p, '/api/admin'));
    expect(outside.length).toBeGreaterThanOrEqual(40);
    const classified = (p: string) => STAFF_SURFACE_PREFIXES.some((s) => prefixMatch(p, s)) || p in PUBLIC_WITH_OPTIONAL_STAFF || p in PUBLIC_ROUTES;
    expect(outside.filter((p) => !classified(p)), 'Ruta nueva sin clasificar: añádela a STAFF_SURFACE_PREFIXES (lib/modules/access.ts) si es de personal, o a la lista pública con su motivo').toEqual([]);
  });

  it('una ruta no puede estar en dos clasificaciones a la vez, ni en la lista pública si es superficie de personal', () => {
    const lists = [Object.keys(PUBLIC_WITH_OPTIONAL_STAFF), Object.keys(PUBLIC_ROUTES)];
    const all = lists.flat();
    expect(all.filter((p, i) => all.indexOf(p) !== i), 'duplicadas').toEqual([]);
    for (const p of Object.keys(PUBLIC_ROUTES)) expect(STAFF_SURFACE_PREFIXES.some((s) => prefixMatch(p, s)), p).toBe(false);
  });

  it('las rutas «públicas» no comprueban sesión de personal (si empiezan a hacerlo, son de personal u opcional: reclasifícalas)', () => {
    const files = new Map(routeFiles(API_DIR).map((f) => [toApiPath(f), f]));
    for (const p of Object.keys(PUBLIC_ROUTES)) {
      if (p === '/api/auth/[...nextauth]') continue; // el propio NextAuth usa getServerSession internamente
      const f = files.get(p);
      expect(f, p).toBeDefined();
      expect(STAFF_CHECK.test(fs.readFileSync(f!, 'utf8')), p).toBe(false);
    }
  });

  it('la lista pública no arrastra rutas que ya no existen', () => {
    const all = new Set(routeFiles(API_DIR).map(toApiPath));
    for (const p of Object.keys(PUBLIC_ROUTES)) expect(all, p).toContain(p);
  });
});
