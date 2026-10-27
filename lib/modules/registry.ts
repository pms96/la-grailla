import type { ModuleKey } from '@grailla/contracts';

/* Registro de módulos: QUIÉN es dueño de cada ruta. Es pura y edge-safe (la usa el middleware).
 *
 * DEFAULT-DENY: una ruta sin dueño no existe para el registro, y en modo plataforma el middleware la corta con 404. Un test enumera
 * todas las páginas y route handlers de `app/` y falla si alguna no tiene dueño, así que una ruta nueva no puede colarse abierta a
 * clientes que no tienen su módulo. `nucleo` es el módulo que siempre está activo.
 *
 * Los prefijos casan por segmento: '/eventos' cubre '/eventos' y '/eventos/x', no '/eventos-viejos'. */

export type RouteOwner = ModuleKey;

type Rule = { prefix: string; owner: RouteOwner; exact?: boolean };

const rules: Rule[] = [
  // ── Núcleo (siempre activo) ───────────────────────────────────────────────
  { prefix: '/', owner: 'nucleo', exact: true },
  { prefix: '/auth', owner: 'nucleo' },
  { prefix: '/legal', owner: 'nucleo' },
  { prefix: '/licencia', owner: 'nucleo' },
  { prefix: '/robots.txt', owner: 'nucleo' },
  { prefix: '/sitemap.xml', owner: 'nucleo' },
  { prefix: '/admin', owner: 'nucleo', exact: true },
  { prefix: '/admin/configuracion', owner: 'nucleo' },
  { prefix: '/admin/usuarios', owner: 'nucleo' },
  { prefix: '/admin/apariencia', owner: 'nucleo' },
  { prefix: '/admin/mensajes', owner: 'nucleo' },
  { prefix: '/admin/secciones', owner: 'nucleo' },
  { prefix: '/api/auth', owner: 'nucleo' },
  { prefix: '/api/signup', owner: 'nucleo' },
  { prefix: '/api/cron', owner: 'nucleo' },
  { prefix: '/api/health', owner: 'nucleo' },
  { prefix: '/api/webhooks', owner: 'nucleo' },
  { prefix: '/api/admin/config', owner: 'nucleo' },
  { prefix: '/api/admin/users', owner: 'nucleo' },
  { prefix: '/api/admin/roles', owner: 'nucleo' },
  { prefix: '/api/admin/theme', owner: 'nucleo' },
  { prefix: '/api/admin/contact', owner: 'nucleo' },
  { prefix: '/api/contact', owner: 'nucleo' },
  { prefix: '/api/admin/change-password', owner: 'nucleo' },
  { prefix: '/api/admin/upload', owner: 'nucleo' },

  // ── Venta de entradas ─────────────────────────────────────────────────────
  { prefix: '/eventos', owner: 'entradas' },
  { prefix: '/confirmacion', owner: 'entradas' },
  { prefix: '/acceso', owner: 'entradas' },
  { prefix: '/admin/eventos', owner: 'entradas' },
  { prefix: '/admin/entradas', owner: 'entradas' },
  { prefix: '/admin/invitaciones', owner: 'entradas' },
  { prefix: '/admin/ventas', owner: 'entradas' },
  { prefix: '/admin/aforo', owner: 'entradas' },
  { prefix: '/admin/escaneos', owner: 'entradas' },
  { prefix: '/admin/estadisticas', owner: 'entradas' },
  { prefix: '/admin/noche', owner: 'entradas' },
  { prefix: '/api/events', owner: 'entradas' },
  { prefix: '/api/orders', owner: 'entradas' },
  { prefix: '/api/queue', owner: 'entradas' },
  { prefix: '/api/scan', owner: 'entradas' },
  { prefix: '/api/access', owner: 'entradas' },
  { prefix: '/api/guest-lists', owner: 'entradas' },
  { prefix: '/api/invitations', owner: 'entradas' },
  { prefix: '/api/taquilla', owner: 'entradas' },
  { prefix: '/api/tickets', owner: 'entradas' },
  { prefix: '/api/admin/events', owner: 'entradas' },
  { prefix: '/api/admin/orders', owner: 'entradas' },
  { prefix: '/api/admin/scans', owner: 'entradas' },
  { prefix: '/api/admin/noche', owner: 'entradas' },
  { prefix: '/api/admin/stats', owner: 'entradas' },
  { prefix: '/api/admin/ticket-types', owner: 'entradas' },
  { prefix: '/api/admin/export', owner: 'entradas' },

  // ── Tienda online ─────────────────────────────────────────────────────────
  { prefix: '/tienda', owner: 'tienda' },
  { prefix: '/admin/productos', owner: 'tienda' },
  { prefix: '/admin/pedidos', owner: 'tienda' },
  { prefix: '/api/products', owner: 'tienda' },
  { prefix: '/api/shop', owner: 'tienda' },
  { prefix: '/api/admin/products', owner: 'tienda' },
  { prefix: '/api/admin/shop-orders', owner: 'tienda' },
  { prefix: '/api/admin/shop-stats', owner: 'tienda' },

  // ── Contabilidad ──────────────────────────────────────────────────────────
  { prefix: '/admin/compras', owner: 'contabilidad' },
  { prefix: '/admin/gastos', owner: 'contabilidad' },
  { prefix: '/admin/ingresos', owner: 'contabilidad' },
  { prefix: '/api/admin/compras', owner: 'contabilidad' },
  { prefix: '/api/admin/gastos', owner: 'contabilidad' },
  { prefix: '/api/admin/ingresos', owner: 'contabilidad' },

  // ── Wallets (suplemento mensual) ──────────────────────────────────────────
  { prefix: '/api/wallet', owner: 'wallets' },

  // ── Sponsors ──────────────────────────────────────────────────────────────
  { prefix: '/sponsors', owner: 'sponsors' },
  { prefix: '/admin/sponsors', owner: 'sponsors' },
  { prefix: '/api/sponsors', owner: 'sponsors' },
  { prefix: '/api/admin/sponsors', owner: 'sponsors' },
  { prefix: '/api/admin/sponsors-portal', owner: 'sponsors' },
];

function normalize(path: string): string {
  const q = path.search(/[?#]/);
  const clean = q === -1 ? path : path.slice(0, q);
  return clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
}

/** Dueño de una ruta, o null si ninguna regla la cubre (default-deny). Gana el prefijo más largo. */
export function ownerOfPath(path: string): RouteOwner | null {
  const p = normalize(path);
  let best: Rule | null = null;
  for (const r of rules) {
    const hit = r.exact ? p === r.prefix : p === r.prefix || p.startsWith(`${r.prefix}/`);
    if (hit && (!best || r.prefix.length > best.prefix.length)) best = r;
  }
  return best?.owner ?? null;
}

/** ¿Debe mostrarse un enlace a esta ruta con estos módulos activos? (menús, navegación pública). Una ruta sin dueño no se muestra. */
export function isLinkVisible(href: string, active: readonly ModuleKey[]): boolean {
  const owner = ownerOfPath(href);
  return owner !== null && ownerEnabled(owner, active);
}

/** Prefijos registrados (para el test que enumera las rutas de `app/`). */
export const REGISTERED_PREFIXES: readonly string[] = rules.map((r) => r.prefix);

/** Un wallet sólo tiene sentido con entradas o con tienda: el módulo no basta por sí solo. */
export const MODULE_REQUIRES_ANY: Partial<Record<ModuleKey, readonly ModuleKey[]>> = { wallets: ['entradas', 'tienda'] };

/** ¿Pueden usarse las rutas de este dueño con estos módulos activos? */
export function ownerEnabled(owner: RouteOwner, active: readonly ModuleKey[]): boolean {
  if (owner === 'nucleo') return true;
  if (!active.includes(owner)) return false;
  const needs = MODULE_REQUIRES_ANY[owner];
  return !needs || needs.some((m) => active.includes(m));
}

/**
 * La PUERTA de un evento: la pantalla del escáner (`/acceso`, solo lectura de la página), la validación (`/api/scan`) y sus lecturas
 * (`/api/access/*`, incluida la lista de eventos `/api/access/events`). Nada de esto vende: solo valida entradas ya vendidas. La
 * autenticación de staff (ADMIN/TAQUILLA) sigue exigida por el middleware y por cada handler; eximir una ruta de la licencia no la abre
 * a anónimos. La pestaña de taquilla del escáner (`/api/taquilla/*`) y las invitaciones NO están aquí: son venta y panel.
 */
export function isDoorPath(path: string, method: string): boolean {
  const p = normalize(path);
  if (p === '/api/scan' || p.startsWith('/api/scan/') || p === '/api/access' || p.startsWith('/api/access/')) return true;
  return (method === 'GET' || method === 'HEAD') && p === '/acceso';
}

/**
 * Rutas que NUNCA se cortan por fase de licencia ni por módulo apagado: dinero ya en vuelo y gente que ya pagó.
 * Un webhook o un cron que no llega es dinero perdido; un comprador debe poder ver y descargar lo que compró; y en la puerta de un
 * evento hay que seguir validando entradas ya vendidas. Las VENTAS nuevas (POST /api/orders, la taquilla, etc.) sí se cortan.
 */
export function isLicenseExempt(path: string, method: string): boolean {
  const p = normalize(path);
  const read = method === 'GET' || method === 'HEAD';
  if (p.startsWith('/api/webhooks/') || p.startsWith('/api/cron/')) return true;
  if (p === '/api/health') return true; // la salud del cliente la lee el panel aunque esté en mantenimiento, suspendido o sin licencia
  if (isDoorPath(p, method)) return true;
  if (p.startsWith('/api/auth/') || p === '/api/auth') return true; // el login de staff debe poder abrirse para ver el aviso
  if (read && (p.startsWith('/confirmacion/') || p.startsWith('/tienda/confirmacion/'))) return true;
  if (read && (/^\/api\/orders\/[^/]+(\/pdf)?$/.test(p) || /^\/api\/shop\/orders\/[^/]+$/.test(p) || p.startsWith('/api/tickets/'))) return true;
  // El comprador que vuelve atrás desde la pasarela (`cancel_url`) libera el aforo/stock de SU pedido sin pagar: no vende nada, solo devuelve lo que
  // reservó, y con la licencia o el módulo cortados ese stock quedaría retenido hasta que lo libere el cron. Exige el token firmado del pedido.
  if (read && /^\/api\/(shop\/)?orders\/[^/]+\/abandon$/.test(p)) return true;
  // Reembolsos y cancelaciones de pedidos ya existentes (PATCH con `action`): el dinero del comprador no depende de que el cliente pague.
  if (method === 'PATCH' && /^\/api\/admin\/orders\/[^/]+$/.test(p)) return true;
  if (p === '/licencia' || p.startsWith('/licencia/') || p.startsWith('/auth/')) return true;
  return false;
}
