import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { TEST_TENANT_IDS, disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Bandeja de contacto (núcleo, M6): formulario público → bandeja → respuesta, con dos clientes en dos BDs reales. */

let sessionRole: 'ADMIN' | 'TAQUILLA' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'u1', email: 'admin@cliente.es', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const sendMailMock = vi.fn(async (_p: { to: string; subject: string; html: string; replyTo?: string }) => ({ success: true as boolean, transport: 'smtp' as const, error: undefined as string | undefined }));
vi.mock('@/lib/mailer', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/mailer')>()), sendMail: (p: Parameters<typeof sendMailMock>[0]) => sendMailMock(p) }));

let env: ReturnType<typeof enablePlatformEnv>;
let contactRoute: typeof import('@/app/api/contact/route');
let listRoute: typeof import('@/app/api/admin/contact/route');
let itemRoute: typeof import('@/app/api/admin/contact/[id]/route');
let replyRoute: typeof import('@/app/api/admin/contact/[id]/reply/route');
let usersRoute: typeof import('@/app/api/admin/users/route');

const valid = { name: 'Lucía Pérez', email: 'lucia@example.com', phone: '600 111 222', subject: 'Reserva de grupo', message: 'Somos 20 personas, ¿tenéis hueco el sábado?', consentAccepted: true as const };
const post = (body: unknown, ip = '203.0.113.7') =>
  new Request('http://localhost/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': ip }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body: unknown) => new Request('http://localhost', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function submit(slot: 'a' | 'b', body: unknown = valid, ip?: string) {
  return withTenantForTest(slot, () => contactRoute.POST(post(body, ip)));
}
const firstId = async (slot: 'a' | 'b') => (await tenantClient(slot).contactMessage.findFirstOrThrow()).id;

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
  contactRoute = await import('@/app/api/contact/route');
  listRoute = await import('@/app/api/admin/contact/route');
  itemRoute = await import('@/app/api/admin/contact/[id]/route');
  replyRoute = await import('@/app/api/admin/contact/[id]/reply/route');
  usersRoute = await import('@/app/api/admin/users/route');
}, 180_000);
beforeEach(async () => {
  sessionRole = 'ADMIN';
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ success: true, transport: 'smtp', error: undefined });
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
  await tenantClient('a').appConfig.create({ data: { key: 'admin_email', value: 'duena@cliente-a.es' } });
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('POST /api/contact (público)', () => {
  it('guarda el mensaje con su consentimiento y avisa al correo del cliente, con el visitante como reply-to', async () => {
    const res = await submit('a');
    expect(res.status).toBe(200);
    const row = await tenantClient('a').contactMessage.findFirstOrThrow();
    expect(row).toMatchObject({ name: 'Lucía Pérez', email: 'lucia@example.com', status: 'NEW', subject: 'Reserva de grupo' });
    expect(row.consentAt).toBeInstanceOf(Date);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe('duena@cliente-a.es');
    expect(mail.replyTo).toBe('lucia@example.com');
    expect(mail.html).toContain('Somos 20 personas');
  });

  it('un cliente sin admin_email guarda el mensaje pero NO lo envía a ninguna otra dirección', async () => {
    const res = await submit('b');
    expect(res.status).toBe(200);
    expect(await tenantClient('b').contactMessage.count()).toBe(1);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('cada mensaje queda en la BD de SU cliente', async () => {
    await submit('a');
    expect(await tenantClient('a').contactMessage.count()).toBe(1);
    expect(await tenantClient('b').contactMessage.count()).toBe(0);
  });

  it('escapa el HTML del visitante en el aviso', async () => {
    await submit('a', { ...valid, name: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script> hola mundo' });
    const html = sendMailMock.mock.calls[0][0].html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it.each([
    ['sin consentimiento', { ...valid, consentAccepted: false }],
    ['sin consentimiento (falta el campo)', { ...valid, consentAccepted: undefined }],
    ['email no válido', { ...valid, email: 'no-es-un-email' }],
    ['mensaje demasiado corto', { ...valid, message: 'hola' }],
    ['mensaje demasiado largo', { ...valid, message: 'x'.repeat(5001) }],
    ['sin nombre', { ...valid, name: '  ' }],
  ])('rechaza %s (400) y no guarda nada', async (_n, body) => {
    expect((await submit('a', body)).status).toBe(400);
    expect(await tenantClient('a').contactMessage.count()).toBe(0);
  });

  it('un cuerpo que no es JSON da 400', async () => {
    const res = await withTenantForTest('a', () => contactRoute.POST(new Request('http://localhost', { method: 'POST', body: 'no json' })));
    expect(res.status).toBe(400);
  });

  it('el campo trampa descarta al bot en silencio: responde bien y no guarda ni avisa', async () => {
    const res = await submit('a', { ...valid, website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(await tenantClient('a').contactMessage.count()).toBe(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('limita el ritmo por IP (5 por hora) y cada IP tiene su cubeta', async () => {
    for (let i = 0; i < 5; i++) expect((await submit('a', valid, '198.51.100.1')).status).toBe(200);
    const blocked = await submit('a', valid, '198.51.100.1');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect((await submit('a', valid, '198.51.100.2')).status).toBe(200);
    expect(await tenantClient('a').contactMessage.count()).toBe(6);
  });

  it('un envío con datos erróneos NO gasta el cupo de envíos buenos', async () => {
    for (let i = 0; i < 8; i++) expect((await submit('a', { ...valid, email: 'mal' }, '198.51.100.50')).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await submit('a', valid, '198.51.100.50')).status).toBe(200);
    expect((await submit('a', valid, '198.51.100.50')).status).toBe(429);
  });

  it('los envíos erróneos tienen su propio tope (no sirve de martillo)', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await submit('a', { ...valid, email: 'mal' }, '198.51.100.60')).status;
    expect(last).toBe(429);
  });

  it('hay un tope global por cliente: muchas IPs no pueden inundar su bandeja', async () => {
    let blockedAt = 0;
    for (let i = 1; i <= 101; i++) {
      const res = await submit('a', valid, `10.${Math.floor(i / 250)}.${i % 250}.1`);
      if (res.status === 429) { blockedAt = i; break; }
    }
    expect(blockedAt).toBe(101);
    expect(await tenantClient('a').contactMessage.count()).toBe(100);
    // y el tope es de cada cliente: B sigue admitiendo mensajes
    expect((await submit('b', valid, '10.9.9.9')).status).toBe(200);
  });

  it('con el formulario apagado el endpoint no existe (404)', async () => {
    await tenantClient('a').appConfig.create({ data: { key: 'contact_form_enabled', value: 'false' } });
    expect((await submit('a')).status).toBe(404);
    expect(await tenantClient('a').contactMessage.count()).toBe(0);
  });

  it('para el cliente legacy el formulario parte apagado (La Grailla no cambia hasta que lo encienda)', async () => {
    const legacy = enablePlatformEnv({ LEGACY_TENANT_ID: TEST_TENANT_IDS.a });
    try {
      expect((await submit('a')).status).toBe(404);
      await tenantClient('a').appConfig.create({ data: { key: 'contact_form_enabled', value: 'true' } });
      expect((await submit('a')).status).toBe(200);
    } finally {
      legacy.restore();
      env = enablePlatformEnv();
    }
  });
});

describe('bandeja del admin', () => {
  beforeEach(async () => {
    await submit('a', valid, '198.51.100.10');
    await submit('a', { ...valid, name: 'Marcos Ruiz', email: 'marcos@example.com', subject: 'Prensa', message: 'Quiero acreditarme para el festival' }, '198.51.100.11');
  });

  it('exige sesión de administrador en todo', async () => {
    const id = await firstId('a');
    for (const role of ['TAQUILLA', null] as const) {
      sessionRole = role;
      expect((await withTenantForTest('a', () => listRoute.GET(new Request('http://localhost/api/admin/contact')))).status).toBe(401);
      expect((await withTenantForTest('a', () => itemRoute.GET(new Request('http://localhost'), ctx(id)))).status).toBe(401);
      expect((await withTenantForTest('a', () => itemRoute.PATCH(json('PATCH', { status: 'ARCHIVED' }), ctx(id)))).status).toBe(401);
      expect((await withTenantForTest('a', () => itemRoute.DELETE(new Request('http://localhost'), ctx(id)))).status).toBe(401);
      expect((await withTenantForTest('a', () => replyRoute.POST(json('POST', { body: 'hola' }), ctx(id)))).status).toBe(401);
    }
    expect(await tenantClient('a').contactMessage.count()).toBe(2);
    expect(sendMailMock).toHaveBeenCalledTimes(2); // solo los dos avisos de alta
  });

  it('lista con recuentos, filtro por estado y búsqueda', async () => {
    const list = async (qs = '') => (await withTenantForTest('a', () => listRoute.GET(new Request(`http://localhost/api/admin/contact${qs}`)))).json();
    const all = await list();
    expect(all.total).toBe(2);
    expect(all.counts).toEqual({ NEW: 2, ANSWERED: 0, ARCHIVED: 0 });
    expect((await list('?q=prensa')).items.map((m: { name: string }) => m.name)).toEqual(['Marcos Ruiz']);
    expect((await list('?q=ACREDITARME')).total).toBe(1);
    expect((await list('?status=ARCHIVED')).total).toBe(0);
    // Un cliente no ve los mensajes de otro.
    const other = await (await withTenantForTest('b', () => listRoute.GET(new Request('http://localhost/api/admin/contact')))).json();
    expect(other.total).toBe(0);
  });

  it('el detalle trae el mensaje y sus respuestas; un id de otro cliente es 404', async () => {
    const id = await firstId('a');
    const res = await withTenantForTest('a', () => itemRoute.GET(new Request('http://localhost'), ctx(id)));
    expect((await res.json()).replies).toEqual([]);
    expect((await withTenantForTest('b', () => itemRoute.GET(new Request('http://localhost'), ctx(id)))).status).toBe(404);
  });

  it('archivar y restaurar; el estado se valida', async () => {
    const id = await firstId('a');
    expect((await withTenantForTest('a', () => itemRoute.PATCH(json('PATCH', { status: 'ARCHIVED' }), ctx(id)))).status).toBe(200);
    expect((await tenantClient('a').contactMessage.findUniqueOrThrow({ where: { id } })).status).toBe('ARCHIVED');
    expect((await withTenantForTest('a', () => itemRoute.PATCH(json('PATCH', { status: 'HACKED' }), ctx(id)))).status).toBe(400);
    // otro cliente no puede cambiarlo
    expect((await withTenantForTest('b', () => itemRoute.PATCH(json('PATCH', { status: 'NEW' }), ctx(id)))).status).toBe(404);
    expect((await tenantClient('a').contactMessage.findUniqueOrThrow({ where: { id } })).status).toBe('ARCHIVED');
  });

  it('eliminar borra el mensaje y sus respuestas (derecho de supresión); otro cliente no puede', async () => {
    const id = await firstId('a');
    await withTenantForTest('a', () => replyRoute.POST(json('POST', { body: 'Claro que sí.' }), ctx(id)));
    expect(await tenantClient('a').contactReply.count()).toBe(1);
    expect((await withTenantForTest('b', () => itemRoute.DELETE(new Request('http://localhost'), ctx(id)))).status).toBe(404);
    expect(await tenantClient('a').contactMessage.count()).toBe(2);
    expect((await withTenantForTest('a', () => itemRoute.DELETE(new Request('http://localhost'), ctx(id)))).status).toBe(200);
    expect(await tenantClient('a').contactMessage.count()).toBe(1);
    expect(await tenantClient('a').contactReply.count()).toBe(0);
  });

  describe('responder', () => {
    it('envía el email al visitante (con el correo del cliente como reply-to), guarda la respuesta y marca el mensaje como respondido', async () => {
      const id = await firstId('a');
      sendMailMock.mockClear();
      const res = await withTenantForTest('a', () => replyRoute.POST(json('POST', { body: 'Hola Lucía,\nSí, tenemos mesa.' }), ctx(id)));
      expect(res.status).toBe(200);
      const mail = sendMailMock.mock.calls[0][0];
      expect(mail.to).toBe('lucia@example.com');
      expect(mail.replyTo).toBe('duena@cliente-a.es');
      expect(mail.subject).toBe('Re: Reserva de grupo');
      expect(mail.html).toContain('Sí, tenemos mesa.');
      expect(mail.html).toContain('Somos 20 personas'); // cita el mensaje original
      const row = await tenantClient('a').contactMessage.findUniqueOrThrow({ where: { id }, include: { replies: true } });
      expect(row.status).toBe('ANSWERED');
      expect(row.replies).toHaveLength(1);
      expect(row.replies[0]).toMatchObject({ emailSent: true, sentBy: 'admin@cliente.es' });
    });

    it('escapa el HTML de la respuesta', async () => {
      const id = await firstId('a');
      sendMailMock.mockClear();
      await withTenantForTest('a', () => replyRoute.POST(json('POST', { body: '<script>alert(1)</script>' }), ctx(id)));
      expect(sendMailMock.mock.calls[0][0].html).not.toContain('<script>');
    });

    it('si el email no sale: 502, queda constancia del intento y el mensaje NO pasa a respondido', async () => {
      const id = await firstId('a');
      sendMailMock.mockResolvedValue({ success: false, transport: 'smtp', error: 'No hay SMTP configurado' });
      const res = await withTenantForTest('a', () => replyRoute.POST(json('POST', { body: 'Hola' }), ctx(id)));
      expect(res.status).toBe(502);
      const row = await tenantClient('a').contactMessage.findUniqueOrThrow({ where: { id }, include: { replies: true } });
      expect(row.status).toBe('NEW');
      expect(row.replies[0]).toMatchObject({ emailSent: false, emailError: 'No hay SMTP configurado' });
    });

    it('rechaza una respuesta vacía y un mensaje que no es de este cliente', async () => {
      const id = await firstId('a');
      expect((await withTenantForTest('a', () => replyRoute.POST(json('POST', { body: '   ' }), ctx(id)))).status).toBe(400);
      expect((await withTenantForTest('b', () => replyRoute.POST(json('POST', { body: 'hola' }), ctx(id)))).status).toBe(404);
    });
  });
});

describe('usuarios con un solo rol salvo con Entradas', () => {
  const create = (role: string) => usersRoute.POST(json('POST', { email: `u-${role.toLowerCase()}@cliente.es`, password: 'una-clave-larga-1', role }));

  it('sin el módulo Entradas no se puede crear un usuario de taquilla', async () => {
    const res = await withTenantForTest('a', () => create('TAQUILLA'), { modules: ['nucleo', 'tienda'] });
    expect(res.status).toBe(400);
    expect(await tenantClient('a').user.count({ where: { role: 'TAQUILLA' } })).toBe(0);
    expect((await withTenantForTest('a', () => create('ADMIN'), { modules: ['nucleo', 'tienda'] })).status).toBe(200);
  });

  it('un usuario de taquilla que ya existe puede seguir editándose (nombre) aunque el cliente haya perdido Entradas', async () => {
    const created = await withTenantForTest('a', () => create('TAQUILLA'), { modules: ['nucleo', 'entradas'] });
    const { id } = await created.json();
    const { PUT } = await import('@/app/api/admin/users/[id]/route');
    const edit = (modules: string[], role?: string) =>
      withTenantForTest('a', () => PUT(json('PUT', { name: 'Nuevo nombre', ...(role ? { role } : {}) }), { params: Promise.resolve({ id }) }), { modules });
    expect((await edit(['nucleo'], 'TAQUILLA')).status).toBe(200);
    // …pero no se puede ASIGNAR taquilla a otra persona sin el módulo.
    const other = await (await withTenantForTest('a', () => create('ADMIN'), { modules: ['nucleo'] })).json();
    const toOther = await withTenantForTest('a', () => PUT(json('PUT', { role: 'TAQUILLA' }), { params: Promise.resolve({ id: other.id }) }), { modules: ['nucleo'] });
    expect(toOther.status).toBe(400);
  });

  it('con el módulo Entradas sí', async () => {
    const res = await withTenantForTest('a', () => create('TAQUILLA'), { modules: ['nucleo', 'entradas'] });
    expect(res.status).toBe(200);
    expect(await tenantClient('a').user.count({ where: { role: 'TAQUILLA' } })).toBe(1);
  });
});
