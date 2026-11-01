import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import type { CredentialsConfig } from 'next-auth/providers/credentials';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/* Endurecimiento del login (revisión integral): H-061 (el límite no debe cerrar la puerta ni gastarse con intentos correctos), H-070 (el tiempo de
 * respuesta no distingue «el email no existe»), H-106 (redirección abierta en el callback `redirect`). */

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const email = `auth-hard-${suffix}@test.local`;
const password = 'una-clave-de-prueba-123';
const ipBase = `10.${200 + Math.floor(Math.random() * 50)}.${Math.floor(Math.random() * 250)}`;
let ipN = 0;
const nextIp = () => `${ipBase}.${++ipN}`;

type Authorize = (credentials: Record<string, string>, req: unknown) => Promise<unknown>;
function authorize(): Authorize {
  const provider = authOptions.providers[0] as unknown as CredentialsConfig & { options: { authorize: Authorize } };
  return provider.options.authorize;
}
const reqFor = (ip: string) => ({ headers: { 'x-vercel-forwarded-for': ip } });
const attempt = (pw: string, ip: string, who = email) => authorize()({ email: who, password: pw }, reqFor(ip));

beforeAll(async () => {
  await prisma.user.create({ data: { email, name: 'Taquilla', role: 'TAQUILLA', hashedPassword: await bcrypt.hash(password, 4) } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { contains: suffix } }, { key: { startsWith: `login-ip:${ipBase}.` } }] } });
});

describe('H-061: el límite de login', () => {
  it('los intentos correctos no gastan cupo: 12 entradas seguidas desde la misma IP no se bloquean', async () => {
    const ip = nextIp();
    for (let i = 0; i < 12; i++) expect(await attempt(password, ip)).toMatchObject({ email });
  });

  it('5 fallos desde la IP de un atacante no impiden entrar a la taquilla desde otra IP', async () => {
    const attacker = nextIp();
    for (let i = 0; i < 5; i++) expect(await attempt('mala', attacker)).toBeNull();
    await expect(attempt('mala', attacker)).rejects.toThrow('too_many_attempts');
    expect(await attempt(password, nextIp())).toMatchObject({ email });
  });

  it('pero la fuerza bruta repartida entre muchas IPs sigue topando con un techo por email', async () => {
    const victim = `auth-hard-victim-${suffix}@test.local`;
    for (let i = 0; i < 30; i++) expect(await attempt('mala', nextIp(), victim)).toBeNull();
    await expect(attempt('mala', nextIp(), victim)).rejects.toThrow('too_many_attempts');
  });
});

describe('H-070: el tiempo de respuesta no revela si el email existe', () => {
  it('con un email desconocido también se hace la comparación bcrypt', async () => {
    const spy = vi.spyOn(bcrypt, 'compare');
    try {
      expect(await attempt('lo-que-sea', nextIp(), `no-existe-${suffix}@test.local`)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('H-106: callback redirect', () => {
  const redirect = (url: string) => authOptions.callbacks!.redirect!({ url, baseUrl: 'https://cliente.test' });

  it('deja pasar rutas internas y el propio origen', async () => {
    expect(await redirect('/admin')).toBe('/admin');
    expect(await redirect('/auth/login?next=%2Fadmin')).toBe('/auth/login?next=%2Fadmin');
    expect(await redirect('https://cliente.test/admin')).toBe('https://cliente.test/admin');
  });

  it.each(['//evil.com', '///evil.com', '/\\evil.com', '/\\/evil.com', 'https://evil.com/x', 'javascript:alert(1)'])('rechaza %s', async (url) => {
    expect(await redirect(url)).toBe('https://cliente.test');
  });
});
