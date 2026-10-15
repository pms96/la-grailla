import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authOptions } from '@/lib/auth';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import { TEST_TENANT_IDS, disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';
import { enablePlatformEnv } from '../helpers/platform';

/* Revisión de módulos (2026-10): la sesión de un admin no se podía revocar (borrarlo o cambiarle la contraseña no cortaba sus sesiones
 * durante 30 días) y el rol vivía solo en el token. Ahora cada lectura de sesión contrasta con la BD del cliente. */

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

type Sess = { user?: { id?: string; role?: string; modules?: string[] | null } };
const db = () => tenantClient('a');
const newUser = (over: Record<string, unknown> = {}) => db().user.create({ data: { email: `u${Math.random().toString(36).slice(2)}@cliente.test`, role: 'ADMIN', ...over } });

/** Inicia sesión como lo hace NextAuth (callback jwt con `user`) y devuelve el token resultante. */
const signIn = (user: { id: string; role: string }) =>
  withTenantForTest('a', () => authOptions.callbacks!.jwt!({ token: {}, user } as never)) as unknown as Promise<Record<string, unknown>>;
const readSession = (token: Record<string, unknown>) =>
  withTenantForTest('a', () => authOptions.callbacks!.session!({ session: { user: {}, expires: 'x' }, token: { ...token, tid: TEST_TENANT_IDS.a } } as never)) as unknown as Promise<Sess>;

describe('Sesión — se contrasta con la BD en cada lectura', () => {
  it('un propietario con sesión válida la conserva, con su rol de la BD y sin restricción de módulos', async () => {
    const u = await newUser();
    const s = await readSession(await signIn(u));
    expect(s.user?.id).toBe(u.id);
    expect(s.user?.role).toBe('ADMIN');
    expect(s.user?.modules).toBeNull();
  });

  it('si borran al usuario, su sesión deja de valer al instante', async () => {
    const u = await newUser();
    const token = await signIn(u);
    await db().user.delete({ where: { id: u.id } });
    expect((await readSession(token)).user).toBeUndefined();
  });

  it('el rol sale de la BD: si lo degradan, la sesión abierta ya no es de admin', async () => {
    const u = await newUser();
    const token = await signIn(u);
    await db().user.update({ where: { id: u.id }, data: { role: 'USER' } });
    expect((await readSession(token)).user?.role).toBe('USER');
  });

  it('«sessionsValidAfter» corta las sesiones iniciadas antes, no las posteriores', async () => {
    const u = await newUser();
    const antes = await signIn(u);
    await new Promise((r) => setTimeout(r, 15));
    await db().user.update({ where: { id: u.id }, data: { sessionsValidAfter: new Date() } });
    expect((await readSession(antes)).user).toBeUndefined();
    await new Promise((r) => setTimeout(r, 15));
    const despues = await signIn(u);
    expect((await readSession(despues)).user?.id).toBe(u.id);
  });

  it('una sesión anterior a esta versión (sin marcas) de un propietario sigue valiendo, y la revocación también la corta', async () => {
    const u = await newUser();
    const legacy = { id: u.id, role: 'ADMIN' };
    expect((await readSession(legacy)).user?.id).toBe(u.id);
    await db().user.update({ where: { id: u.id }, data: { sessionsValidAfter: new Date() } });
    expect((await readSession(legacy)).user).toBeUndefined();
  });
});

describe('Roles — el rol de la BD manda sobre lo que lleve el token', () => {
  it('un usuario con rol predefinido recibe sus módulos en la sesión', async () => {
    const u = await newUser({ accessRole: 'tienda' });
    const s = await readSession(await signIn(u));
    expect(s.user?.modules).toEqual(['tienda']);
  });

  it('un usuario con rol personalizado recibe los módulos de su rol', async () => {
    const role = await db().accessRole.create({ data: { name: 'Tienda y cuentas', modules: ['tienda', 'contabilidad'] } });
    const u = await newUser({ accessRole: `c_${role.id}` });
    expect((await readSession(await signIn(u))).user?.modules).toEqual(['tienda', 'contabilidad']);
  });

  it('si le cambian el rol con la sesión abierta, esa sesión se cierra (hay que entrar de nuevo)', async () => {
    const u = await newUser();
    const token = await signIn(u);
    await db().user.update({ where: { id: u.id }, data: { accessRole: 'tienda' } });
    expect((await readSession(token)).user).toBeUndefined();
  });

  it('si editan los módulos de un rol personalizado, las sesiones de quienes lo tienen se cierran', async () => {
    const role = await db().accessRole.create({ data: { name: 'Equipo', modules: ['tienda'] } });
    const u = await newUser({ accessRole: `c_${role.id}` });
    const token = await signIn(u);
    await db().accessRole.update({ where: { id: role.id }, data: { modules: ['tienda', 'entradas'] } });
    expect((await readSession(token)).user).toBeUndefined();
  });

  it('un rol desconocido (o un rol personalizado borrado) no da acceso a ningún módulo', async () => {
    const u = await newUser({ accessRole: 'rol-inventado' });
    expect((await readSession(await signIn(u))).user?.modules).toEqual([]);
    const gone = await newUser({ accessRole: 'c_noexiste' });
    expect((await readSession(await signIn(gone))).user?.modules).toEqual([]);
  });

  it('el token lleva los módulos para que el middleware (sin BD) pueda cortar rutas', async () => {
    const u = await newUser({ accessRole: 'tienda' });
    const token = await signIn(u);
    expect(token.mods).toEqual(['tienda']);
    const owner = await signIn(await newUser());
    expect(owner.mods).toBeUndefined();
  });
});
