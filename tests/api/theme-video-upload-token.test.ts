import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HERO_VIDEO_MAX_BYTES } from '@/lib/brand/hero-video';

/* Ruta que emite el token con el que el panel sube el vídeo de cabecera de «cine» directo a Blob. Se simula `handleUpload` llamando al
 * `onBeforeGenerateToken` que le pasa la ruta, igual que haría el SDK real (patrón de tests/api/sponsors-portal-upload.test.ts). */

const state = vi.hoisted(() => ({ role: 'ADMIN' as string | null }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => (state.role ? { user: { id: 'u1', role: state.role } } : null)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@vercel/blob/client', () => ({
  handleUpload: vi.fn(async ({ body, onBeforeGenerateToken }: any) => {
    const { pathname, clientPayload, multipart } = body.payload;
    const options = await onBeforeGenerateToken(pathname, clientPayload ?? null, multipart ?? false);
    return { type: 'blob.generate-client-token', clientToken: 'fake-client-token', ...options };
  }),
}));

const { POST } = await import('@/app/api/admin/theme/video-upload-token/route');

const call = (pathname: string) =>
  POST(
    new Request('http://localhost/api/admin/theme/video-upload-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'blob.generate-client-token', payload: { pathname, multipart: false, clientPayload: null } }),
    })
  );

beforeEach(() => {
  state.role = 'ADMIN';
});

describe('POST /api/admin/theme/video-upload-token', () => {
  it('sin sesión de administrador: 401', async () => {
    state.role = null;
    expect((await call('brand/hero/a.mp4')).status).toBe(401);
    state.role = 'TAQUILLA';
    expect((await call('brand/hero/a.mp4')).status).toBe(401);
  });

  it('un administrador recibe un token solo para MP4 o WebM y con tamaño máximo', async () => {
    const res = await call('brand/hero/abc-hero.mp4');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowedContentTypes: string[]; maximumSizeInBytes: number; clientToken: string };
    expect(body.clientToken).toBe('fake-client-token');
    expect(body.allowedContentTypes).toEqual(['video/mp4', 'video/webm']);
    expect(body.maximumSizeInBytes).toBe(HERO_VIDEO_MAX_BYTES);
  });

  it('rechaza rutas fuera de la carpeta del vídeo, con saltos de carpeta o con otra extensión', async () => {
    for (const bad of ['brand/logo/a.mp4', 'uploads/a.mp4', 'brand/hero/../../otro/a.mp4', 'brand/hero/a.exe', 'brand/hero/a.html', 'sponsors/1/final-video/a.mp4']) {
      const res = await call(bad);
      expect(res.status, bad).toBeGreaterThanOrEqual(400);
    }
  });
});
