import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectAllTenantClients } from '@/lib/tenant/db';
import {
  PASSWORD_TOKEN_TTL_MS,
  hashPasswordToken,
  newPasswordToken,
  passwordLink,
  passwordProblem,
  passwordTokenIdentifier,
} from '@/lib/platform/password-token';
import { enablePlatformEnv } from '../helpers/platform';
import { disconnectTenantClients, ensureTenantDatabases, resetTenantDatabase, tenantClient, withTenantForTest } from '../helpers/tenant-dbs';

/* Invitación para fijar la contraseña (fase 3): el panel escribe un token en la BD del cliente y la web del cliente lo canjea. Aquí se
 * simula la parte del panel escribiendo la fila con las MISMAS funciones compartidas (lib/platform/password-token.ts). */

let env: ReturnType<typeof enablePlatformEnv>;
let route: typeof import('@/app/api/auth/set-password/route');

const EMAIL = 'duena@cliente-a.es';
const post = (body: unknown, ip = '203.0.113.9') =>
  new Request('http://localhost/api/auth/set-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': ip }, body: JSON.stringify(body) });
const submit = (slot: 'a' | 'b', body: unknown, ip?: string) => withTenantForTest(slot, () => route.POST(post(body, ip)));

async function invite(slot: 'a' | 'b', opts: { email?: string; identifier?: string; ttlMs?: number } = {}) {
  const { token, hash } = newPasswordToken();
  await tenantClient(slot).verificationToken.create({
    data: { identifier: opts.identifier ?? passwordTokenIdentifier(opts.email ?? EMAIL), token: hash, expires: new Date(Date.now() + (opts.ttlMs ?? PASSWORD_TOKEN_TTL_MS)) },
  });
  return token;
}

beforeAll(async () => {
  await ensureTenantDatabases();
  env = enablePlatformEnv();
  route = await import('@/app/api/auth/set-password/route');
}, 180_000);
beforeEach(async () => {
  await resetTenantDatabase('a');
  await resetTenantDatabase('b');
  await tenantClient('a').user.create({ data: { email: EMAIL, name: 'Dueña', role: 'ADMIN', hashedPassword: await bcrypt.hash('aleatoria-que-nadie-conoce', 4) } });
});
afterAll(async () => {
  env?.restore?.();
  await disconnectAllTenantClients();
  await disconnectTenantClients();
});

describe('el token', () => {
  it('guarda solo el hash: el token del enlace no está en la BD', async () => {
    const token = await invite('a');
    const rows = await tenantClient('a').verificationToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(hashPasswordToken(token));
    expect(rows[0].token).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].identifier).toBe(`pwset:${EMAIL}`);
  });

  it('el enlace apunta al dominio del cliente con el token codificado', () => {
    const link = passwordLink('web.cliente-a.es', 'a+b/c=');
    expect(link).toBe('https://web.cliente-a.es/auth/establecer-contrasena?token=a%2Bb%2Fc%3D');
  });

  it('exige una contraseña razonable', () => {
    expect(passwordProblem('corta')).toMatch(/al menos 10/);
    expect(passwordProblem(' '.repeat(12))).toMatch(/espacios/);
    expect(passwordProblem('á'.repeat(40))).toMatch(/demasiado larga/);
    expect(passwordProblem(undefined)).toBeTruthy();
    expect(passwordProblem('una contraseña larga')).toBeNull();
  });
});

describe('POST /api/auth/set-password', () => {
  it('con un enlace válido fija la contraseña, gasta el token y permite entrar con ella', async () => {
    const token = await invite('a');
    const res = await submit('a', { token, password: 'mi contraseña nueva 1' });
    expect(res.status).toBe(200);
    const user = await tenantClient('a').user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(await bcrypt.compare('mi contraseña nueva 1', user.hashedPassword!)).toBe(true);
    expect(await tenantClient('a').verificationToken.count()).toBe(0);
  });

  it('el mismo enlace no se puede usar dos veces', async () => {
    const token = await invite('a');
    expect((await submit('a', { token, password: 'primera contraseña 1' })).status).toBe(200);
    const again = await submit('a', { token, password: 'segunda contraseña 2' });
    expect(again.status).toBe(400);
    const user = await tenantClient('a').user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(await bcrypt.compare('primera contraseña 1', user.hashedPassword!)).toBe(true);
  });

  it('dos peticiones a la vez con el mismo enlace: solo una gana', async () => {
    const token = await invite('a');
    const results = await Promise.all([
      submit('a', { token, password: 'contraseña carrera A1' }, '203.0.113.20'),
      submit('a', { token, password: 'contraseña carrera B2' }, '203.0.113.21'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('un enlace caducado no vale y no toca la contraseña', async () => {
    const token = await invite('a', { ttlMs: -1000 });
    const before = (await tenantClient('a').user.findUniqueOrThrow({ where: { email: EMAIL } })).hashedPassword;
    const res = await submit('a', { token, password: 'contraseña nueva 123' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no es válido o ha caducado/);
    expect((await tenantClient('a').user.findUniqueOrThrow({ where: { email: EMAIL } })).hashedPassword).toBe(before);
  });

  it('un token inventado y uno de otro cliente dan el mismo error genérico', async () => {
    const tokenA = await invite('a');
    const invented = await submit('a', { token: 'x'.repeat(43), password: 'contraseña nueva 123' });
    const otherTenant = await submit('b', { token: tokenA, password: 'contraseña nueva 123' });
    expect(invented.status).toBe(400);
    expect(otherTenant.status).toBe(400);
    expect(await invented.json()).toEqual(await otherTenant.json());
    // El token de A sigue intacto: el intento en B no lo gastó.
    expect(await tenantClient('a').verificationToken.count()).toBe(1);
  });

  it('una contraseña débil se rechaza sin gastar el token', async () => {
    const token = await invite('a');
    const res = await submit('a', { token, password: 'corta' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/al menos 10/);
    expect(await tenantClient('a').verificationToken.count()).toBe(1);
    expect((await submit('a', { token, password: 'ahora sí es larga' })).status).toBe(200);
  });

  it('solo valen los tokens de este tipo y de usuarios que existen', async () => {
    const other = await invite('a', { identifier: 'otro-uso:' + EMAIL });
    expect((await submit('a', { token: other, password: 'contraseña nueva 123' })).status).toBe(400);
    const ghost = await invite('a', { email: 'nadie@cliente-a.es' });
    expect((await submit('a', { token: ghost, password: 'contraseña nueva 123' })).status).toBe(400);
  });

  it('canjear un enlace anula las demás invitaciones pendientes del mismo usuario', async () => {
    const first = await invite('a');
    const second = await invite('a');
    expect((await submit('a', { token: second, password: 'contraseña nueva 123' })).status).toBe(200);
    expect(await tenantClient('a').verificationToken.count()).toBe(0);
    expect((await submit('a', { token: first, password: 'otra contraseña 456' })).status).toBe(400);
  });

  it('datos que no son JSON o sin campos dan 400 y no rompen', async () => {
    const bad = await withTenantForTest('a', () => route.POST(new Request('http://localhost/api/auth/set-password', { method: 'POST', body: 'no-json', headers: { 'x-vercel-forwarded-for': '203.0.113.30' } })));
    expect(bad.status).toBe(400);
    expect((await submit('a', {}, '203.0.113.31')).status).toBe(400);
    expect((await submit('a', { token: 123, password: ['x'] }, '203.0.113.32')).status).toBe(400);
  });

  it('limita los intentos por IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await submit('a', { token: 'y'.repeat(43), password: 'contraseña nueva 123' }, '198.51.100.77')).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
