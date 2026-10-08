import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import type { CredentialsConfig } from 'next-auth/providers/credentials';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// La sesión es JWT y solo hay un proveedor Credentials: no debe haber adapter
// (se quitó el PrismaAdapter, que nunca se ejecutaba) y el login tiene que
// seguir funcionando de punta a punta contra la BD.

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const email = `auth-options-${suffix}@test.local`;
const password = 'una-clave-de-prueba-123';
let userId = '';

type Authorize = (credentials: Record<string, string>, req: unknown) => Promise<unknown>;
function authorize(): Authorize {
  const provider = authOptions.providers[0] as unknown as CredentialsConfig & { options: { authorize: Authorize } };
  return provider.options.authorize;
}
// IP distinta por llamada: el rate limit de IP vive en la misma BD y no debe contaminar otros tests.
const reqFor = (ip: string) => ({ headers: { 'x-vercel-forwarded-for': ip } });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email, name: 'Test', role: 'TAQUILLA', hashedPassword: await bcrypt.hash(password, 4) },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: suffix } } });
});

describe('authOptions', () => {
  it('no usa adapter y la sesión es JWT', () => {
    expect(authOptions.adapter).toBeUndefined();
    expect(authOptions.session?.strategy).toBe('jwt');
  });

  it('login correcto devuelve id, email y rol', async () => {
    const user = await authorize()({ email, password }, reqFor(`10.0.0.${Math.floor(Math.random() * 200) + 1}`));
    expect(user).toMatchObject({ id: userId, email, role: 'TAQUILLA' });
  });

  it('contraseña incorrecta o usuario inexistente devuelven null', async () => {
    expect(await authorize()({ email, password: 'otra' }, reqFor('10.1.0.1'))).toBeNull();
    expect(await authorize()({ email: `no-existe-${suffix}@test.local`, password }, reqFor('10.1.0.2'))).toBeNull();
  });

  it('los callbacks copian id y rol del usuario al token y del token a la sesión', async () => {
    const token = await authOptions.callbacks!.jwt!({
      token: {},
      user: { id: userId, role: 'TAQUILLA' },
    } as never);
    expect(token).toMatchObject({ id: userId, role: 'TAQUILLA' });
    const session = await authOptions.callbacks!.session!({
      session: { user: {}, expires: '' },
      token,
    } as never);
    expect(session.user).toMatchObject({ id: userId, role: 'TAQUILLA' });
  });
});
