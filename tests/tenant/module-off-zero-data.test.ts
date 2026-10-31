/// <reference types="vite/client" />
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_KEY_OWNERS } from '@/lib/config-ownership';
import { isSensitiveConfigKey } from '@/lib/secrets';
import { ownerEnabled, ownerOfPath } from '@/lib/modules/registry';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* «Módulo apagado = cero datos» (revisión de módulos, 2026-10).
 *
 * El middleware corta las RUTAS de un módulo apagado, pero un endpoint de otro módulo (o del núcleo) podía seguir leyendo sus tablas.
 * Los tests dirigidos solo cubren los casos que ya conocemos; este es el genérico:
 *
 *  1. Toda tabla de Prisma declara a qué módulo pertenece (un modelo nuevo sin dueño rompe el CI, igual que una ruta sin dueño).
 *  2. Para cada combinación de módulos activos se llama a TODOS los GET que el middleware dejaría pasar, una vez con los datos de los
 *     módulos apagados y otra sin ellos. Las dos respuestas tienen que ser idénticas: si un endpoint cambia porque existen datos de un
 *     módulo que el cliente no tiene, hay una fuga.
 *
 * Cubre lectura (GET) de route handlers. No cubre las páginas (server components) ni la escritura (POST/PUT/PATCH/DELETE). */

const state = vi.hoisted(() => ({ modules: null as string[] | null }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { id: 'seed1', role: 'ADMIN', modules: state.modules } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

type Mod = 'nucleo' | 'entradas' | 'tienda' | 'contabilidad' | 'sponsors' | 'wallets';
const ALL: Mod[] = ['nucleo', 'entradas', 'tienda', 'contabilidad', 'sponsors', 'wallets'];

/** Dueño de cada tabla. Las de NextAuth y de infraestructura son del núcleo. */
const MODEL_OWNERS: Record<string, Mod> = {
  User: 'nucleo', AccessRole: 'nucleo', Account: 'nucleo', Session: 'nucleo', VerificationToken: 'nucleo', ContactMessage: 'nucleo',
  ContactReply: 'nucleo', LegalSnapshot: 'nucleo', AppConfig: 'nucleo', RateLimitBucket: 'nucleo', ProcessedWebhookEvent: 'nucleo', AdminAuditLog: 'nucleo',
  Event: 'entradas', WaitingRoomEntry: 'entradas', TicketType: 'entradas', Order: 'entradas', Ticket: 'entradas', ScanLog: 'entradas',
  GuestList: 'entradas', Invitation: 'entradas',
  Product: 'tienda', ProductVariant: 'tienda', ShopOrder: 'tienda', ShopOrderItem: 'tienda',
  SponsorRequest: 'sponsors', Sponsor: 'sponsors', SponsorAsset: 'sponsors', SponsorVideoPrompt: 'sponsors', PromptGenerationLog: 'sponsors',
  SponsorEmailLog: 'sponsors',
  Temporada: 'contabilidad', Proveedor: 'contabilidad', Articulo: 'contabilidad', PrecioArticulo: 'contabilidad',
  ConsumoHistorico: 'contabilidad', PlanCompra: 'contabilidad', Pedido: 'contabilidad', LineaPedido: 'contabilidad', Gasto: 'contabilidad',
  Ingreso: 'contabilidad',
};

describe('cada tabla de Prisma tiene un módulo dueño', () => {
  const schema = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model (\w+) /gm)].map((m) => m[1]);

  it('ningún modelo queda sin clasificar (declara su dueño en MODEL_OWNERS de este test)', () => {
    expect(models.length).toBeGreaterThan(30);
    expect(models.filter((m) => !(m in MODEL_OWNERS)), 'modelos sin dueño').toEqual([]);
  });

  it('no sobran entradas en MODEL_OWNERS', () => {
    expect(Object.keys(MODEL_OWNERS).filter((m) => !models.includes(m))).toEqual([]);
  });
});

/** Route handlers con GET, con su ruta pública (segmentos dinámicos → `seed1`) y los parámetros que Next les pasaría. */
function getRoutes() {
  const root = path.join(process.cwd(), 'app', 'api');
  const out: { file: string; url: string; params: Record<string, string | string[]> }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'route.ts' && /export\s+(async\s+)?function\s+GET\b|export\s+const\s+GET\b/.test(fs.readFileSync(full, 'utf8'))) {
        const segments = path.relative(path.join(process.cwd(), 'app'), dir).split(path.sep);
        const params: Record<string, string | string[]> = {};
        const url =
          '/' +
          segments
            .map((s) => {
              const rest = /^\[\.\.\.(\w+)\]$/.exec(s);
              if (rest) {
                params[rest[1]] = ['seed1'];
                return 'seed1';
              }
              const one = /^\[(\w+)\]$/.exec(s);
              if (one) {
                params[one[1]] = 'seed1';
                return 'seed1';
              }
              return s;
            })
            .join('/');
        out.push({ file: path.relative(process.cwd(), full), url, params });
      }
    }
  };
  walk(root);
  return out;
}

/** Lo que se carga de cada módulo. `present` = módulos cuyos datos existen en la BD. Todo con ids fijos para poder comparar. */
async function seed(present: ReadonlySet<Mod>) {
  const db = tenantClient('a');
  const has = (m: Mod) => present.has(m);
  const day = new Date('2026-06-01T10:00:00Z');
  const eventDate = new Date('2026-12-01T20:00:00Z');

  await db.user.create({ data: { id: 'seed1', email: 'duenio@example.com', name: 'Dueño', role: 'ADMIN' } });
  const message = await db.contactMessage.create({ data: { id: 'seed1', name: 'Visitante', email: 'v@example.com', message: 'Hola' } });
  await db.contactReply.create({ data: { id: 'seed1', messageId: message.id, body: 'Respuesta' } });
  await db.accessRole.create({ data: { id: 'seed1', name: 'Rol de prueba', modules: ['tienda'] } });

  // Una clave de configuración por cada clave no secreta de cada módulo (los secretos tienen sus propios tests de cifrado).
  for (const [key, owners] of Object.entries(CONFIG_KEY_OWNERS)) {
    const mod = owners[0] as Mod;
    if (owners.length !== 1 || mod === 'nucleo' || !has(mod) || isSensitiveConfigKey(key)) continue;
    await db.appConfig.create({ data: { id: `cfg-${key}`, key, value: `valor-${mod}`, label: key, group: mod } });
  }

  const temporadaId = has('contabilidad') ? 'seed1' : null;
  if (has('contabilidad')) {
    await db.temporada.create({ data: { id: 'seed1', nombre: 'Temporada 2026', anio: 2026 } });
    await db.proveedor.create({ data: { id: 'seed1', nombre: 'Proveedor de prueba' } });
    await db.articulo.create({ data: { id: 'seed1', nombre: 'Artículo de prueba', categoria: 'Bebida', formato: 'caja' } });
    await db.precioArticulo.create({ data: { id: 'seed1', articuloId: 'seed1', proveedorId: 'seed1', precioSinIva: 12.5, formatoVenta: 'caja' } });
    await db.consumoHistorico.create({ data: { id: 'seed1', articuloId: 'seed1', temporadaId: 'seed1', cantidadNeta: 10 } });
    await db.planCompra.create({ data: { id: 'seed1', temporadaId: 'seed1', articuloId: 'seed1' } });
    await db.pedido.create({ data: { id: 'seed1', temporadaId: 'seed1', proveedorId: 'seed1' } });
    await db.lineaPedido.create({ data: { id: 'seed1', pedidoId: 'seed1', articuloId: 'seed1', cantidad: 2, precioSinIva: 12.5, ivaPercent: 21 } });
    await db.gasto.create({ data: { id: 'seed1', temporadaId: 'seed1', categoria: 'Bebida', concepto: 'Gasto de prueba', importeSinIva: 4444.44, fecha: day } });
    await db.ingreso.create({ data: { id: 'seed1', temporadaId: 'seed1', fecha: day, concepto: 'Ingreso de prueba', importe: 5555.55 } });
  }

  if (has('entradas')) {
    await db.event.create({ data: { id: 'seed1', name: 'Evento de prueba', slug: 'seed1', venue: 'Sala', city: 'Valencia', date: eventDate, status: 'PUBLISHED', temporadaId } });
    await db.ticketType.create({ data: { id: 'seed1', eventId: 'seed1', name: 'General', price: 15 } });
    await db.order.create({ data: { id: 'seed1', eventId: 'seed1', buyerName: 'Ana', buyerLastName: 'Test', buyerEmail: 'ana@example.com', totalAmount: 1111.11, status: 'COMPLETED' } });
    await db.ticket.create({ data: { id: 'seed1', orderId: 'seed1', eventId: 'seed1', qrCode: 'seed1', holderName: 'Ana Test' } });
    await db.scanLog.create({ data: { id: 'seed1', ticketId: 'seed1', eventId: 'seed1', result: 'VALID' } });
    await db.waitingRoomEntry.create({ data: { id: 'seed1', eventId: 'seed1', token: 'seed1' } });
    await db.guestList.create({ data: { id: 'seed1', eventId: 'seed1', name: 'Lista de prueba' } });
    await db.invitation.create({ data: { id: 'seed1', eventId: 'seed1', guestName: 'Invitado de prueba' } });
  }

  if (has('tienda')) {
    await db.product.create({ data: { id: 'seed1', name: 'Producto de prueba', slug: 'seed1', price: 20, temporadaId } });
    await db.productVariant.create({ data: { id: 'seed1', productId: 'seed1' } });
    await db.shopOrder.create({
      data: { id: 'seed1', buyerName: 'Luis', buyerEmail: 'luis@example.com', shippingAddress: 'Calle 1', shippingCity: 'Valencia', shippingZip: '46001', totalAmount: 2222.22, temporadaId },
    });
    await db.shopOrderItem.create({ data: { id: 'seed1', shopOrderId: 'seed1', productId: 'seed1', unitPrice: 20 } });
  }

  if (has('sponsors')) {
    await db.sponsorRequest.create({ data: { id: 'seed1', companyName: 'Marca de prueba SL', contactName: 'Pepe', email: 'marca@example.com', temporadaId } });
    await db.sponsor.create({ data: { id: 'seed1', sponsorRequestId: 'seed1', isPaid: true, paidAmount: 3333.33 } });
    await db.sponsorAsset.create({ data: { id: 'seed1', sponsorId: 'seed1', url: 'https://example.com/x.png', fileType: 'image/png', fileName: 'x.png', fileSize: 10 } });
    await db.sponsorVideoPrompt.create({ data: { id: 'seed1', sponsorId: 'seed1', promptEs: 'prompt es', promptEn: 'prompt en' } });
    await db.promptGenerationLog.create({ data: { id: 'seed1', sponsorId: 'seed1', attemptNumber: 1 } });
    await db.sponsorEmailLog.create({ data: { id: 'seed1', sponsorRequestId: 'seed1', type: 'LEAD_CONFIRMATION', recipient: 'marca@example.com', success: true } });
  }
}

type Snapshot = Map<string, string>;

/** Hora y duraciones cambian entre dos cargas aunque los datos sean los mismos: no son parte de lo que se compara. */
const normalize = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<fecha>');

const loaders = import.meta.glob('../../app/api/**/route.ts');
const routes = getRoutes();

/** Llama a todos los GET que el middleware dejaría pasar con estos módulos activos y devuelve estado + cuerpo de cada uno. */
async function readAll(active: readonly Mod[]): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  state.modules = null; // propietario: ve todo lo que sus módulos activos permitan
  for (const r of routes) {
    const owner = ownerOfPath(r.url);
    if (owner === null || !ownerEnabled(owner, active)) continue;
    const loader = loaders['../../' + r.file.replace(/\\/g, '/')];
    expect(loader, `no se encuentra ${r.file}`).toBeTruthy();
    const mod = (await loader()) as { GET: (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response> | Response };
    let body: string;
    try {
      const res = await Promise.race([
        withTenantForTest('a', () => mod.GET(new Request(`http://a.cliente.test${r.url}`), { params: Promise.resolve(r.params) }), { modules: [...active] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000)),
      ]);
      const type = res.headers.get('content-type') ?? '';
      // Un PDF o un Excel llevan fechas y marcas internas: de ellos solo se compara que respondan igual (estado).
      const textual = /json|text|csv|html|xml/.test(type) || type === '';
      body = `${res.status} ${textual ? normalize(await res.text()) : `[${type}]`}`;
    } catch (error) {
      body = `EXCEPCIÓN ${error instanceof Error ? error.message : String(error)}`;
    }
    snap.set(`${r.url} (${r.file})`, body);
  }
  return snap;
}

let env: ReturnType<typeof enablePlatformEnv>;
beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
}, 180_000);
beforeEach(async () => {
  await resetTenantDatabase('a');
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

/** Combinaciones: solo el núcleo, y todo menos cada módulo de negocio. */
const SCENARIOS: { name: string; active: Mod[] }[] = [
  { name: 'solo núcleo', active: ['nucleo'] },
  ...(['entradas', 'tienda', 'contabilidad', 'sponsors', 'wallets'] as Mod[]).map((off) => ({
    name: `todo menos ${off}`,
    active: ALL.filter((m) => m !== off),
  })),
];

/** Diferencias que son legítimas (con la razón). Vacío: cualquier diferencia es una fuga hasta que se demuestre lo contrario. */
const KNOWN_EXCEPTIONS: Record<string, string> = {};

describe('módulo apagado = la respuesta no depende de sus datos', () => {
  it('hay rutas GET que comprobar (si no, el test no demuestra nada)', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  for (const scenario of SCENARIOS) {
    it(
      `${scenario.name}: los GET permitidos responden igual con y sin los datos de los módulos apagados`,
      async () => {
        const disabled = ALL.filter((m) => !scenario.active.includes(m));
        const keep = new Set<Mod>(ALL.filter((m) => scenario.active.includes(m)));

        await seed(new Set(ALL));
        const withData = await readAll(scenario.active);
        await resetTenantDatabase('a');
        await seed(keep);
        const withoutData = await readAll(scenario.active);

        expect(withData.size).toBeGreaterThan(5);
        const leaks: string[] = [];
        for (const [key, body] of withData) {
          if (key in KNOWN_EXCEPTIONS) continue;
          const other = withoutData.get(key);
          if (body !== other) {
            const i = [...body].findIndex((c, idx) => c !== other?.[idx]);
            leaks.push(`${key}\n    con datos:  …${body.slice(Math.max(0, i - 40), i + 80)}\n    sin datos:  …${(other ?? '').slice(Math.max(0, i - 40), i + 80)}`);
          }
        }
        expect(leaks, `Con ${disabled.join(', ')} apagados, estas rutas cambian según existan sus datos:\n${leaks.join('\n')}`).toEqual([]);
      },
      180_000
    );
  }
});
