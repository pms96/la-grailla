/// <reference types="vite/client" />
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { CONFIG_KEY_OWNERS } from '@/lib/config-ownership';
import { isSensitiveConfigKey } from '@/lib/secrets';
import { ownerEnabled, ownerOfPath } from '@/lib/modules/registry';
import { STAFF_SURFACE_PREFIXES, pathAllowedForModules } from '@/lib/modules/access';
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
  ContactReply: 'nucleo', LegalSnapshot: 'nucleo', AppConfig: 'nucleo', RateLimitBucket: 'nucleo', PendingSlot: 'nucleo', ProcessedWebhookEvent: 'nucleo', AdminAuditLog: 'nucleo',
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
// Las fechas ISO y las del CSV de ventas en hora de Madrid («dd/mm/aaaa hh:mm», H-137) cambian de una ejecución a otra: no son datos de los módulos apagados.
// H-149: también las ISO con desplazamiento (`+00:00`) o sin zona, que antes pasaban sin normalizar.
const normalize = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<fecha>').replace(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/g, '<fecha>');

const loaders = import.meta.glob('../../app/api/**/route.ts');
const routes = getRoutes();

/* H-149: 29 de los 64 GET leen `searchParams` y se llamaban sin query, así que respondían 400/401 («falta el evento», «falta la temporada») IGUAL con y sin datos: el test pasaba sin
 * demostrar nada sobre ellos. Aquí va la query mínima con la que cada uno hace su trabajo de verdad (los ids son los fijos de `seed`). Una ruta nueva que exija un parámetro y no
 * esté aquí rompe `RESPUESTAS_NO_2XX` más abajo (tiene que justificarse o recibir su query). */
const QUERY: Record<string, string> = {
  '/api/access/capacity': 'eventId=seed1',
  '/api/access/search': 'eventId=seed1&q=ana',
  '/api/queue/status': 'eventId=seed1&token=seed1',
  '/api/guest-lists': 'eventId=seed1',
  '/api/invitations': 'eventId=seed1',
  '/api/admin/noche': 'eventId=seed1',
  '/api/admin/scans': 'eventId=seed1',
  '/api/admin/stats': 'eventId=seed1',
  '/api/admin/stats/ventas-por-dia': 'eventId=seed1',
  '/api/admin/orders': 'eventId=seed1',
  '/api/admin/export': 'type=orders&eventId=seed1',
  '/api/admin/events': 'incluirArchivados=1',
  '/api/admin/shop-orders/export': 'status=',
  '/api/admin/ingresos': 'temporadaId=seed1&anulados=1',
  '/api/admin/ingresos/resumen': 'temporadaId=seed1',
  '/api/admin/gastos': 'temporadaId=seed1&anulados=1',
  '/api/admin/gastos/resumen': 'temporadaId=seed1',
  '/api/admin/gastos/export': 'temporadaId=seed1&format=excel',
  '/api/admin/compras/pedidos': 'temporadaId=seed1',
  '/api/admin/compras/pedidos/export': 'temporadaId=seed1&format=excel',
  '/api/admin/compras/planificador': 'temporadaId=seed1',
  '/api/admin/compras/planificador/export': 'temporadaId=seed1&format=excel',
  '/api/admin/compras/articulos/export': 'format=excel',
  '/api/admin/compras/proveedores/export': 'format=excel',
  '/api/admin/compras/temporadas': 'incluirArchivados=1',
  '/api/admin/contact': 'q=hola',
};

/** Las celdas de todas las hojas de un Excel, en texto (hoja, fila, valores), para comparar el contenido sin las marcas internas del zip. */
async function excelCells(buffer: ArrayBuffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const lines: string[] = [];
  workbook.eachSheet((sheet) => {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => lines.push(JSON.stringify(row.values)));
  });
  return lines.join('\n');
}

/** ¿Es una ruta que un rol restringido ve limitada por módulos? La administración y las superficies de personal; el resto es público. */
const isRoleRestricted = (url: string) =>
  url === '/api/admin' || url.startsWith('/api/admin/') || STAFF_SURFACE_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`));

/** Llama a todos los GET que el middleware dejaría pasar con estos módulos activos y devuelve estado + cuerpo de cada uno. */
async function readAll(active: readonly Mod[], role: readonly Mod[] | null = null): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  state.modules = role ? [...role] : null; // propietario (null): ve todo lo que sus módulos activos permitan; un rol restringido, solo lo suyo
  for (const r of routes) {
    const owner = ownerOfPath(r.url);
    if (owner === null || !ownerEnabled(owner, active)) continue;
    // Con un rol restringido solo cuenta lo que el rol limita: la administración y las superficies de personal (las APIs públicas dan lo mismo a cualquiera: datos de módulos ACTIVOS).
    if (role && (!isRoleRestricted(r.url) || !pathAllowedForModules(r.url, role))) continue;
    const loader = loaders['../../' + r.file.replace(/\\/g, '/')];
    expect(loader, `no se encuentra ${r.file}`).toBeTruthy();
    const mod = (await loader()) as { GET: (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response> | Response };
    let body: string;
    try {
      const res = await Promise.race([
        withTenantForTest('a', () => mod.GET(new Request(`http://a.cliente.test${r.url}${QUERY[r.url] ? `?${QUERY[r.url]}` : ''}`), { params: Promise.resolve(r.params) }), { modules: [...active] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000)),
      ]);
      const type = res.headers.get('content-type') ?? '';
      if (/spreadsheetml/.test(type)) {
        // H-149: un Excel es un zip con marcas de creación (y casaba con `xml`, así que se comparaba como texto y SIEMPRE difería). Se compara lo que ve quien lo abre: las celdas.
        body = `${res.status} ${normalize(await excelCells(await res.arrayBuffer()))}`;
      } else {
        // Un PDF lleva fechas y marcas internas: de él solo se compara que responda igual (estado).
        const textual = /json|^text\/|csv|html|\+xml|application\/xml/.test(type) || type === '';
        body = `${res.status} ${textual ? normalize(await res.text()) : `[${type}]`}`;
      }
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

/** Respuestas que NO son 2xx con todos los módulos activos y los parámetros mínimos, con la razón (H-149). Cualquier ruta que falle por «falta un parámetro» sale aquí y obliga a darle su query. */
const RESPUESTAS_NO_2XX: Record<string, string> = {
  '/api/orders/seed1/abandon': 'el abandono exige el token firmado del pedido (401 sin él)',
  '/api/shop/orders/seed1/abandon': 'el abandono exige el token firmado del pedido (401 sin él)',
  '/api/events/seed1/minor-authorization': 'el evento de la semilla no tiene autorización de menores (404)',
  '/api/cron/cleanup-waiting-room': 'sin CRON_SECRET en el entorno de la prueba el cron no se ejecuta (500)',
  '/api/cron/reconcile-gateway': 'sin CRON_SECRET en el entorno de la prueba el cron no se ejecuta (500)',
  '/api/cron/reconcile-payments': 'sin CRON_SECRET en el entorno de la prueba el cron no se ejecuta (500)',
  '/api/wallet/apple/seed1': 'las wallets no están configuradas en la semilla (503)',
  '/api/wallet/google/seed1': 'las wallets no están configuradas en la semilla (503)',
};
/** Con todo activo, al menos tantas rutas deben dar 2xx con cuerpo (hoy 56 de 64): si baja, el test ha dejado de demostrar algo. */
const MIN_ROUTES_WITH_BODY = 50;

/** Diferencias que son legítimas (con la razón). Vacío: cualquier diferencia es una fuga hasta que se demuestre lo contrario. */
const KNOWN_EXCEPTIONS: Record<string, string> = {};

const statusOf = (body: string) => Number(body.slice(0, 3));
const urlOf = (key: string) => key.slice(0, key.indexOf(' ('));

describe('módulo apagado = la respuesta no depende de sus datos', () => {
  it('hay rutas GET que comprobar (si no, el test no demuestra nada)', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  // H-149: antes solo se exigía `size > 5` y `routes.length > 40`, que se cumplían con casi todo respondiendo 400.
  it('con todos los módulos activos casi todas las rutas responden 2xx con cuerpo (el test lee datos de verdad), y las que no, están justificadas', async () => {
    await seed(new Set(ALL));
    const snap = await readAll(ALL);
    const withBody = [...snap].filter(([, body]) => statusOf(body) >= 200 && statusOf(body) < 300 && body.length > 8);
    expect(withBody.length).toBeGreaterThanOrEqual(MIN_ROUTES_WITH_BODY);
    const notOk = [...snap].filter(([, body]) => !(statusOf(body) >= 200 && statusOf(body) < 300)).map(([key]) => urlOf(key));
    expect(notOk.sort(), 'rutas que no dan 2xx: dales su query en QUERY o justifícalas en RESPUESTAS_NO_2XX').toEqual(Object.keys(RESPUESTAS_NO_2XX).sort());
  }, 180_000);

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
        // H-149: una ruta que no contesta en 20 s no es «igual con y sin datos»: es un fallo del test (y su handler sigue escribiendo tras el siguiente TRUNCATE). Se dice claro.
        const timeouts = [...withData, ...withoutData].filter(([, body]) => body.startsWith('EXCEPCIÓN timeout')).map(([key]) => key);
        expect(timeouts, 'rutas que no respondieron a tiempo').toEqual([]);
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

/* H-149: solo se probaba el propietario. Un administrador con ROL restringido también ve esas respuestas, y sus módulos activos son todos: lo que no es de su rol no debe cambiar
 * la respuesta aunque el módulo esté activo en el cliente. Misma comparación, con y sin los datos de los módulos que no son del rol. */
const ROLES: { name: string; role: Mod[]; exceptions?: Record<string, string> }[] = [
  { name: 'solo núcleo (contenido y mensajes)', role: ['nucleo'] },
  { name: 'gestor de tienda', role: ['tienda'] },
  {
    name: 'contable',
    role: ['contabilidad'],
    // Decisión de producto abierta (revisión integral, lote 8): el resumen de gastos calcula el margen con los ingresos AGREGADOS de entradas y de patrocinio (cifras, no datos de personas).
    // Si el dueño decide que un contable no debe verlas sin el rol de entradas/sponsors, se corrige la ruta y se quita esta excepción.
    exceptions: { '/api/admin/gastos/resumen': 'el margen incluye el total cobrado en entradas y en patrocinio (agregado)' },
  },
  {
    name: 'gestor de entradas',
    role: ['entradas', 'wallets'],
    // El evento lleva su temporada como etiqueta (id y nombre) para el selector del formulario; no se expone ningún dato contable.
    exceptions: { '/api/admin/events': 'cada evento muestra el nombre de su temporada (etiqueta, no datos de Contabilidad)' },
  },
];

/** Con un rol restringido, el id de la temporada de un evento, producto o pedido es una clave opaca que depende de si existen datos de Contabilidad: no es contenido de otro módulo. */
const withoutSeasonId = (text: string) => text.replace(/"temporadaId":(null|"seed1")/g, '"temporadaId":"<id>"');

describe('rol restringido: la respuesta no depende de los datos de módulos que no son de su rol', () => {
  for (const { name, role, exceptions = {} } of ROLES) {
    it(
      `${name}: los GET permitidos responden igual con y sin los datos de los demás módulos`,
      async () => {
        const mine = new Set<Mod>(role);
        await seed(new Set(ALL));
        const withData = await readAll(ALL, role);
        await resetTenantDatabase('a');
        await seed(mine);
        const withoutData = await readAll(ALL, role);

        expect(withData.size).toBeGreaterThan(3);
        const timeouts = [...withData, ...withoutData].filter(([, body]) => body.startsWith('EXCEPCIÓN timeout')).map(([key]) => key);
        expect(timeouts, 'rutas que no respondieron a tiempo').toEqual([]);
        const leaks: string[] = [];
        for (const [key, rawBody] of withData) {
          if (key in KNOWN_EXCEPTIONS || urlOf(key) in exceptions) continue;
          const body = withoutSeasonId(rawBody);
          const other = withoutSeasonId(withoutData.get(key) ?? '');
          if (body !== other) {
            const i = [...body].findIndex((c, idx) => c !== other[idx]);
            leaks.push(`${key}\n    con datos:  …${body.slice(Math.max(0, i - 40), i + 80)}\n    sin datos:  …${other.slice(Math.max(0, i - 40), i + 80)}`);
          }
        }
        // Una excepción que ya no hace falta se quita: si la ruta dejó de depender de otros módulos, el test lo dice.
        for (const url of Object.keys(exceptions)) {
          const key = [...withData.keys()].find((k) => urlOf(k) === url);
          expect(key, `${url}: la excepción apunta a una ruta que ya no se comprueba`).toBeDefined();
          expect(withoutSeasonId(withData.get(key!)!), `${url}: ya no depende de otros módulos, quita la excepción`).not.toBe(withoutSeasonId(withoutData.get(key!) ?? ''));
        }
        expect(leaks, `Con el rol «${name}», estas rutas cambian según existan datos de otros módulos:\n${leaks.join('\n')}`).toEqual([]);
      },
      180_000
    );
  }
});
