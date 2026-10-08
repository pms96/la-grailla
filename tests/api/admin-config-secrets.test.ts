import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { SECRET_MASK, encryptSecret } from '@/lib/secrets';
import { getConfig } from '@/lib/config';

let sessionRole: 'ADMIN' | 'TAQUILLA' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-config-secrets-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET, PUT } = await import('@/app/api/admin/config/route');

// Se usan dos claves de poco impacto de la BD de desarrollo y se restauran al terminar.
const SECRET_KEY = 'abacus_ai_api_key';
const PLAIN_SMTP_KEY = 'smtp_password';
const TOUCHED = [SECRET_KEY, PLAIN_SMTP_KEY];

function put(configs: { key: string; value: string }[]): Request {
  return new Request('http://localhost', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configs }),
  });
}

async function stored(key: string): Promise<string | undefined> {
  return (await prisma.appConfig.findUnique({ where: { key } }))?.value;
}

// AUDIT: GET /api/admin/config devolvía las credenciales descifradas al
// navegador y el PUT las reescribía tal cual llegaban — si un valor cifrado
// no se podía descifrar (devolvía ''), el siguiente "Guardar" lo sobrescribía
// con vacío y la credencial se perdía en silencio.
describe('/api/admin/config — credenciales de solo escritura', () => {
  const original = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of TOUCHED) original.set(key, await stored(key));
    await prisma.appConfig.upsert({
      where: { key: SECRET_KEY },
      update: { value: encryptSecret('abacus-secreto-real') },
      create: { key: SECRET_KEY, value: encryptSecret('abacus-secreto-real'), label: SECRET_KEY, group: 'general' },
    });
    await prisma.appConfig.upsert({
      where: { key: PLAIN_SMTP_KEY },
      update: { value: 'smtp-en-claro' },
      create: { key: PLAIN_SMTP_KEY, value: 'smtp-en-claro', label: PLAIN_SMTP_KEY, group: 'smtp' },
    });
  });

  afterAll(async () => {
    for (const key of TOUCHED) {
      const value = original.get(key);
      if (value === undefined) await prisma.appConfig.deleteMany({ where: { key } });
      else await prisma.appConfig.update({ where: { key }, data: { value } });
    }
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = 'TAQUILLA';
    expect((await GET()).status).toBe(401);
    expect((await PUT(put([{ key: SECRET_KEY, value: 'x' }]))).status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('GET devuelve la máscara, nunca el valor ni el blob cifrado', async () => {
    const res = await GET();
    const body = (await res.json()) as { key: string; value: string }[];
    for (const key of TOUCHED) {
      expect(body.find((c) => c.key === key)?.value).toBe(SECRET_MASK);
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('abacus-secreto-real');
    expect(raw).not.toContain('smtp-en-claro');
    expect(raw).not.toContain('enc:v1:');
  });

  it('PUT con la máscara no toca el valor guardado', async () => {
    const before = await stored(SECRET_KEY);
    const res = await PUT(put([{ key: SECRET_KEY, value: SECRET_MASK }, { key: PLAIN_SMTP_KEY, value: SECRET_MASK }]));
    expect(res.status).toBe(200);
    expect(await stored(SECRET_KEY)).toBe(before);
    expect(await stored(PLAIN_SMTP_KEY)).toBe('smtp-en-claro');
    expect(await getConfig(SECRET_KEY)).toBe('abacus-secreto-real');
  });

  it('PUT con un valor nuevo lo cifra (credenciales) o lo guarda tal cual (smtp_password, por ahora)', async () => {
    await PUT(put([{ key: SECRET_KEY, value: '  abacus-nuevo  ' }, { key: PLAIN_SMTP_KEY, value: 'smtp-nuevo' }]));
    expect((await stored(SECRET_KEY))?.startsWith('enc:v1:')).toBe(true);
    expect(await getConfig(SECRET_KEY)).toBe('abacus-nuevo');
    expect(await stored(PLAIN_SMTP_KEY)).toBe('smtp-nuevo');
    expect(await getConfig(PLAIN_SMTP_KEY)).toBe('smtp-nuevo');
  });

  it('PUT con vacío borra la credencial (acción explícita)', async () => {
    await PUT(put([{ key: SECRET_KEY, value: '' }]));
    expect(await stored(SECRET_KEY)).toBe('');
  });

  it('getConfig lee una smtp_password ya cifrada (release de solo lectura)', async () => {
    await prisma.appConfig.update({ where: { key: PLAIN_SMTP_KEY }, data: { value: encryptSecret('smtp-cifrado') } });
    expect(await getConfig(PLAIN_SMTP_KEY)).toBe('smtp-cifrado');
  });

  it('un valor cifrado que no se puede abrir degrada a vacío en getConfig y NO se sobrescribe desde el formulario', async () => {
    const original = process.env.NEXTAUTH_SECRET;
    const blob = encryptSecret('algo');
    await prisma.appConfig.update({ where: { key: SECRET_KEY }, data: { value: blob } });
    process.env.NEXTAUTH_SECRET = 'secreto-rotado-por-error';
    try {
      expect(await getConfig(SECRET_KEY)).toBe('');
      const body = (await (await GET()).json()) as { key: string; value: string }[];
      expect(body.find((c) => c.key === SECRET_KEY)?.value).toBe(SECRET_MASK);
      await PUT(put([{ key: SECRET_KEY, value: SECRET_MASK }]));
      expect(await stored(SECRET_KEY)).toBe(blob);
    } finally {
      process.env.NEXTAUTH_SECRET = original;
    }
  });
});
