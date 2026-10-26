import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Roles por módulo: predefinidos y personalizados con alias, asignados a usuarios, y sesiones revocables. Decisión del dueño (2026-10-15). */

const state = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

let env: ReturnType<typeof enablePlatformEnv>;
const MODULES = ['nucleo', 'entradas', 'tienda', 'contabilidad', 'sponsors'];
const db = () => tenantClient('a');
let ownerId: string;

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
}, 180_000);
beforeEach(async () => {
  await resetTenantDatabase('a');
  const owner = await db().user.create({ data: { email: 'owner@cliente.test', role: 'ADMIN', hashedPassword: await bcrypt.hash('clave-actual-1', 4) } });
  ownerId = owner.id;
  state.session = { user: { id: ownerId, role: 'ADMIN', modules: null } };
});
afterAll(async () => {
  env?.restore();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

const json = (method: string, body?: unknown) => new Request('http://a.cliente.test/api/admin/x', { method, body: body === undefined ? undefined : JSON.stringify(body) });
const asTenant = <T>(fn: () => T) => withTenantForTest('a', fn, { modules: MODULES });
const restricted = () => { state.session = { user: { id: ownerId, role: 'ADMIN', modules: ['nucleo', 'tienda'] } }; };

const roles = () => import('@/app/api/admin/roles/route');
const roleById = () => import('@/app/api/admin/roles/[id]/route');
const users = () => import('@/app/api/admin/users/route');
const userById = () => import('@/app/api/admin/users/[id]/route');

describe('Roles personalizados', () => {
  it('el listado trae los predefinidos y los del cliente', async () => {
    await db().accessRole.create({ data: { name: 'Tienda y cuentas', modules: ['tienda', 'contabilidad'] } });
    const { GET } = await roles();
    const data = (await (await asTenant(() => GET())).json()) as { presets: { key: string; label: string; modules: string[] }[]; custom: { name: string; modules: string[] }[] };
    expect(data.presets.map((p) => p.key).sort()).toEqual(['contabilidad', 'contenido', 'entradas', 'sponsors', 'tienda']);
    expect(data.custom).toMatchObject([{ name: 'Tienda y cuentas', modules: ['tienda', 'contabilidad'] }]);
  });

  it('crear un rol con alias y módulos de la lista', async () => {
    const { POST } = await roles();
    const res = await asTenant(() => POST(json('POST', { name: '  Equipo de verano ', modules: ['entradas', 'tienda'] })));
    expect(res.status).toBe(201);
    expect(await db().accessRole.findMany()).toMatchObject([{ name: 'Equipo de verano', modules: ['entradas', 'tienda'] }]);
  });

  it('rechaza módulos que no existen, sin módulos, un alias repetido y el de un rol predefinido', async () => {
    const { POST } = await roles();
    expect((await asTenant(() => POST(json('POST', { name: 'Raro', modules: ['inventado'] })))).status).toBe(400);
    expect((await asTenant(() => POST(json('POST', { name: 'Vacío', modules: [] })))).status).toBe(400);
    expect((await asTenant(() => POST(json('POST', { name: 'Gestor de tienda', modules: ['tienda'] })))).status).toBe(400);
    await asTenant(() => POST(json('POST', { name: 'Equipo', modules: ['tienda'] })));
    expect((await asTenant(() => POST(json('POST', { name: 'equipo', modules: ['entradas'] })))).status).toBe(409);
  });

  it('editar un rol cambia sus módulos', async () => {
    const role = await db().accessRole.create({ data: { name: 'Equipo', modules: ['tienda'] } });
    const { PUT } = await roleById();
    const res = await asTenant(() => PUT(json('PUT', { name: 'Equipo', modules: ['tienda', 'contabilidad'] }), { params: Promise.resolve({ id: role.id }) }));
    expect(res.status).toBe(200);
    expect((await db().accessRole.findUnique({ where: { id: role.id } }))?.modules).toEqual(['tienda', 'contabilidad']);
    expect((await asTenant(() => PUT(json('PUT', { name: 'X', modules: ['tienda'] }), { params: Promise.resolve({ id: 'noexiste' }) }))).status).toBe(404);
  });

  it('borrar un rol sin usuarios lo elimina; con usuarios se niega', async () => {
    const libre = await db().accessRole.create({ data: { name: 'Libre', modules: ['tienda'] } });
    const usado = await db().accessRole.create({ data: { name: 'Usado', modules: ['tienda'] } });
    await db().user.create({ data: { email: 'gestor@cliente.test', role: 'ADMIN', accessRole: `c_${usado.id}` } });
    const { DELETE } = await roleById();
    expect((await asTenant(() => DELETE(json('DELETE'), { params: Promise.resolve({ id: libre.id }) }))).status).toBe(200);
    const res = await asTenant(() => DELETE(json('DELETE'), { params: Promise.resolve({ id: usado.id }) }));
    expect(res.status).toBe(409);
    expect(await db().accessRole.count()).toBe(1);
  });

  it('un administrador con rol restringido no puede ver ni tocar los roles (aunque el middleware se saltara)', async () => {
    restricted();
    const { GET, POST } = await roles();
    expect((await asTenant(() => GET())).status).toBe(403);
    expect((await asTenant(() => POST(json('POST', { name: 'Poder', modules: ['tienda'] })))).status).toBe(403);
  });
});

describe('Asignar un rol a un usuario', () => {
  const create = async (body: Record<string, unknown>) => {
    const { POST } = await users();
    return asTenant(() => POST(json('POST', { password: 'clave-larga-1', ...body })));
  };

  it('crea un administrador con un rol predefinido o con uno personalizado', async () => {
    expect((await create({ email: 'tienda@cliente.test', role: 'ADMIN', accessRole: 'tienda' })).status).toBe(200);
    const role = await db().accessRole.create({ data: { name: 'Equipo', modules: ['tienda'] } });
    expect((await create({ email: 'equipo@cliente.test', role: 'ADMIN', accessRole: `c_${role.id}` })).status).toBe(200);
    const rows = await db().user.findMany({ where: { email: { in: ['tienda@cliente.test', 'equipo@cliente.test'] } }, orderBy: { email: 'asc' } });
    expect(rows.map((r) => r.accessRole)).toEqual([`c_${role.id}`, 'tienda']);
  });

  it('rechaza un rol desconocido, uno personalizado que no existe y un rol en alguien que no es administrador', async () => {
    expect((await create({ email: 'a@cliente.test', role: 'ADMIN', accessRole: 'inventado' })).status).toBe(400);
    expect((await create({ email: 'b@cliente.test', role: 'ADMIN', accessRole: 'c_noexiste' })).status).toBe(400);
    expect((await create({ email: 'c@cliente.test', role: 'USER', accessRole: 'tienda' })).status).toBe(400);
  });

  it('sin rol se crea un propietario, como siempre', async () => {
    await create({ email: 'dueno2@cliente.test', role: 'ADMIN' });
    expect((await db().user.findUnique({ where: { email: 'dueno2@cliente.test' } }))?.accessRole).toBeNull();
  });

  it('cambiar el rol de un usuario lo guarda; no puedes cambiarte el tuyo ni dejar al cliente sin propietario', async () => {
    const gestor = await db().user.create({ data: { email: 'g@cliente.test', role: 'ADMIN' } });
    const { PUT } = await userById();
    expect((await asTenant(() => PUT(json('PUT', { accessRole: 'tienda' }), { params: Promise.resolve({ id: gestor.id }) }))).status).toBe(200);
    expect((await db().user.findUnique({ where: { id: gestor.id } }))?.accessRole).toBe('tienda');
    // Volver a propietario con null.
    expect((await asTenant(() => PUT(json('PUT', { accessRole: null }), { params: Promise.resolve({ id: gestor.id }) }))).status).toBe(200);
    // A uno mismo no.
    expect((await asTenant(() => PUT(json('PUT', { accessRole: 'tienda' }), { params: Promise.resolve({ id: ownerId }) }))).status).toBe(400);
  });

  it('no se puede restringir al último propietario', async () => {
    const otro = await db().user.create({ data: { email: 'otro@cliente.test', role: 'ADMIN', accessRole: 'tienda' } });
    state.session = { user: { id: otro.id, role: 'ADMIN', modules: null } }; // quien actúa (simulado) no es el propietario único
    const { PUT } = await userById();
    const res = await asTenant(() => PUT(json('PUT', { accessRole: 'tienda' }), { params: Promise.resolve({ id: ownerId }) }));
    expect(res.status).toBe(400);
  });

  it('el listado devuelve el rol de cada usuario', async () => {
    await db().user.create({ data: { email: 'g@cliente.test', role: 'ADMIN', accessRole: 'tienda' } });
    const { GET } = await users();
    const list = (await (await asTenant(() => GET())).json()) as { email: string; accessRole: string | null }[];
    expect(list.find((u) => u.email === 'g@cliente.test')?.accessRole).toBe('tienda');
    expect(list.find((u) => u.email === 'owner@cliente.test')?.accessRole).toBeNull();
  });

  it('un administrador con rol restringido no puede crear, editar ni borrar usuarios', async () => {
    restricted();
    const { GET, POST } = await users();
    const { PUT, DELETE } = await userById();
    expect((await asTenant(() => GET())).status).toBe(403);
    expect((await asTenant(() => POST(json('POST', { email: 'x@cliente.test', password: 'clave-larga-1', role: 'ADMIN' })))).status).toBe(403);
    expect((await asTenant(() => PUT(json('PUT', { accessRole: null }), { params: Promise.resolve({ id: ownerId }) }))).status).toBe(403);
    expect((await asTenant(() => DELETE(json('DELETE'), { params: Promise.resolve({ id: ownerId }) }))).status).toBe(403);
  });
});

describe('Revocar sesiones', () => {
  it('restablecer la contraseña de alguien le cierra las sesiones abiertas', async () => {
    const u = await db().user.create({ data: { email: 'v@cliente.test', role: 'ADMIN' } });
    const { PUT } = await userById();
    expect((await asTenant(() => PUT(json('PUT', { password: 'otra-clave-larga' }), { params: Promise.resolve({ id: u.id }) }))).status).toBe(200);
    expect((await db().user.findUnique({ where: { id: u.id } }))?.sessionsValidAfter).not.toBeNull();
  });

  it('cambiar el rol de alguien también le cierra las sesiones', async () => {
    const u = await db().user.create({ data: { email: 'v2@cliente.test', role: 'ADMIN' } });
    const { PUT } = await userById();
    await asTenant(() => PUT(json('PUT', { accessRole: 'tienda' }), { params: Promise.resolve({ id: u.id }) }));
    expect((await db().user.findUnique({ where: { id: u.id } }))?.sessionsValidAfter).not.toBeNull();
  });

  it('cambiar tu propia contraseña cierra tus sesiones y avisa de que hay que volver a entrar', async () => {
    const { POST } = await import('@/app/api/admin/change-password/route');
    const res = await asTenant(() => POST(json('POST', { currentPassword: 'clave-actual-1', newPassword: 'clave-nueva-larga' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, signOut: true });
    expect((await db().user.findUnique({ where: { id: ownerId } }))?.sessionsValidAfter).not.toBeNull();
  });
});
