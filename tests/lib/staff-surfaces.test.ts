import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { STAFF_SURFACE_PREFIXES } from '@/lib/modules/access';

/* P1-03: cada API que comprueba una sesión de PERSONAL tiene que estar clasificada. Si cuelga de /api/admin, el control por módulo ya la cubre. Si no,
 * tiene que ser una superficie de personal (STAFF_SURFACE_PREFIXES, restringida por módulo) o estar en la lista de excepciones de abajo con su motivo.
 * Una API de staff nueva fuera de /api/admin que se olvide de esto rompe la CI en vez de quedar abierta a cualquier rol restringido. */

const API_DIR = path.join(process.cwd(), 'app', 'api');
const STAFF_CHECK = /getServerSession|isStaffSession|isAdminSession/;

/** APIs públicas que miran la sesión solo para dar MÁS al personal (o para ceder el paso al comprador con su token). No son superficies de personal. */
const PUBLIC_WITH_OPTIONAL_STAFF: Record<string, string> = {
  '/api/events': 'listado público de eventos; con sesión de personal añade borradores (solo lectura)',
  '/api/events/[slug]': 'ficha pública del evento; con sesión de personal ve también los no publicados',
  '/api/orders/[orderId]/send-tickets': 'reenvío de entradas: lo usa el comprador con su token o el personal desde el admin',
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
});
