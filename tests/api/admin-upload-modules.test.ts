import { describe, it, expect, vi, beforeEach } from 'vitest';

type TestSession = { user: { id: string; role: string; modules: string[] | null } } | null;
let session: TestSession = null;
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
const stored: string[] = [];
vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (path: string) => {
    stored.push(path);
    return { url: `https://x.public.blob.vercel-storage.com/${path}` };
  }),
}));

const { POST } = await import('@/app/api/admin/upload/route');
const as = (modules: string[] | null): TestSession => ({ user: { id: 'u', role: 'ADMIN', modules } });
function upload(prefix?: string) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'foto.png', { type: 'image/png' }));
  if (prefix !== undefined) form.append('prefix', prefix);
  return POST(new Request('http://localhost/api/admin/upload', { method: 'POST', body: form }));
}

beforeEach(() => {
  stored.length = 0;
});

/* H-068: cualquier rol restringido podía subir imágenes al almacén público (coste y contenido) aunque no tuviera nada que ilustrar. Ahora cada carpeta
 * de subida pertenece a un módulo; el propietario sube a cualquiera. */
describe('POST /api/admin/upload por módulo (H-068)', () => {
  it('cada carpeta pide su módulo: brand/sections → núcleo, events → entradas, products → tienda, compras-listados → contabilidad', async () => {
    const cases: [string, string][] = [['brand', 'nucleo'], ['sections', 'nucleo'], ['events', 'entradas'], ['products', 'tienda'], ['compras-listados', 'contabilidad']];
    for (const [prefix, owner] of cases) {
      session = as([owner]);
      expect((await upload(prefix)).status, `${prefix} con ${owner}`).toBe(200);
      session = as(['wallets']);
      expect((await upload(prefix)).status, `${prefix} sin ${owner}`).toBe(403);
    }
    expect(stored).toHaveLength(cases.length);
  });

  it('un rol restringido no sube a una carpeta sin dueño (ni a la de por defecto); el propietario sí', async () => {
    session = as(['tienda']);
    expect((await upload('lo-que-sea')).status).toBe(403);
    expect((await upload()).status).toBe(403);
    session = as(null);
    expect((await upload('lo-que-sea')).status).toBe(200);
    expect((await upload()).status).toBe(200);
  });

  it('sigue exigiendo sesión de ADMIN', async () => {
    session = null;
    expect((await upload('brand')).status).toBe(401);
    session = { user: { id: 't', role: 'TAQUILLA', modules: null } };
    expect((await upload('brand')).status).toBe(401);
  });
});
