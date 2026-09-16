import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { signSponsorAccess } from '@/lib/access-token';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => null),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

// El binario ya no pasa por nuestras rutas — el navegador lo sube
// directamente a Vercel Blob usando un token que emite upload-token/route.ts
// (ver ese archivo). Aquí se simula esa llamada invocando directamente el
// `onBeforeGenerateToken` que le pasamos, igual que haría el SDK real.
vi.mock('@vercel/blob/client', () => ({
  handleUpload: vi.fn(async ({ body, onBeforeGenerateToken }: any) => {
    const { pathname, clientPayload, multipart } = body.payload;
    const options = await onBeforeGenerateToken(pathname, clientPayload ?? null, multipart ?? false);
    return { type: 'blob.generate-client-token', clientToken: 'fake-client-token', ...options };
  }),
}));

const { POST: uploadLogo } = await import('@/app/api/sponsors/portal/[sponsorId]/logo/route');
const { POST: getUploadToken } = await import('@/app/api/sponsors/portal/[sponsorId]/logo/upload-token/route');
const { GET: getSponsor } = await import('@/app/api/sponsors/portal/[sponsorId]/route');

function tokenRequest(url: string, pathname: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'blob.generate-client-token', payload: { pathname, multipart: false, clientPayload: null } }),
  });
}

function confirmRequest(url: string, file: { url: string; fileName: string; fileType: string; fileSize: number }): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(file),
  });
}

describe('POST /api/sponsors/portal/[sponsorId]/logo/upload-token', () => {
  let sponsorRequestId: string;
  let sponsorId: string;
  let token: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Token Sponsor SL',
        contactName: 'Titular Token',
        email: 'sponsor-token-test@example.com',
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    sponsorRequestId = request.id;
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId } });
    sponsorId = sponsor.id;
    token = signSponsorAccess(sponsorId, sponsor.portalTokenVersion);
  });

  afterAll(async () => {
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: sponsorRequestId } });
  });

  it('rechaza sin token', async () => {
    const res = await getUploadToken(tokenRequest('http://localhost', `sponsors/${sponsorId}/x-logo.png`), { params: { sponsorId } });
    expect(res.status).toBe(401);
  });

  // AUDIT: el sponsorId de la URL debe contrastarse contra el token — el
  // token de OTRO sponsor no debe poder pedir un token de subida para este.
  it('rechaza el token de otro sponsor (IDOR)', async () => {
    const otherToken = signSponsorAccess('otro-sponsor-id', 1);
    const res = await getUploadToken(
      tokenRequest(`http://localhost?t=${otherToken}`, `sponsors/${sponsorId}/x-logo.png`),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(401);
  });

  // AUDIT: el pathname lo elige el cliente antes de pedir el token — sin
  // esta comprobación, un sponsor autenticado podría pedir un token válido
  // para escribir en la carpeta de blob de OTRO sponsor.
  it('rechaza un pathname fuera de la carpeta de este sponsor', async () => {
    const res = await getUploadToken(
      tokenRequest(`http://localhost?t=${token}`, `sponsors/otro-sponsor-id/x-logo.png`),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(500);
  });

  it('rechaza si la solicitud ya está cerrada', async () => {
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'RECHAZADO' } });
    const res = await getUploadToken(
      tokenRequest(`http://localhost?t=${token}`, `sponsors/${sponsorId}/x-logo.png`),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(409);
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'PENDIENTE_MATERIALES' } });
  });

  it('emite un token con los formatos y el tamaño máximo permitidos', async () => {
    const res = await getUploadToken(
      tokenRequest(`http://localhost?t=${token}`, `sponsors/${sponsorId}/x-logo.png`),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.allowedContentTypes).toEqual(
      expect.arrayContaining(['image/png', 'video/mp4', 'video/x-matroska'])
    );
    expect(data.maximumSizeInBytes).toBe(50 * 1024 * 1024);
  });
});

describe('POST /api/sponsors/portal/[sponsorId]/logo (confirmación tras subir a Blob)', () => {
  let sponsorRequestId: string;
  let sponsorId: string;
  let token: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Test Sponsor SL',
        contactName: 'Titular Test',
        email: 'sponsor-test@example.com',
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    sponsorRequestId = request.id;
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId } });
    sponsorId = sponsor.id;
    token = signSponsorAccess(sponsorId, sponsor.portalTokenVersion);
  });

  afterAll(async () => {
    await prisma.sponsorAsset.deleteMany({ where: { sponsorId } });
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: sponsorRequestId } });
  });

  it('rechaza sin token', async () => {
    const res = await uploadLogo(
      confirmRequest('http://localhost', { url: `https://blob.test/sponsors/${sponsorId}/logo.png`, fileName: 'logo.png', fileType: 'image/png', fileSize: 100 }),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(401);
  });

  it('rechaza un tipo de archivo no permitido', async () => {
    const res = await uploadLogo(
      confirmRequest(`http://localhost?t=${token}`, { url: `https://blob.test/sponsors/${sponsorId}/malware.exe`, fileName: 'malware.exe', fileType: 'application/x-msdownload', fileSize: 100 }),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(400);
  });

  // AUDIT: la URL confirmada debe pertenecer de verdad a este sponsor — sin
  // esto, un cliente podría "colar" la URL del blob de otro sponsor (que ya
  // es pública) como si fuera su propio material.
  it('rechaza una URL que no pertenece a este sponsor', async () => {
    const res = await uploadLogo(
      confirmRequest(`http://localhost?t=${token}`, { url: `https://blob.test/sponsors/otro-sponsor-id/logo.png`, fileName: 'logo.png', fileType: 'image/png', fileSize: 100 }),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(400);
  });

  it('acepta un logo válido y lo deja como currentAsset', async () => {
    const res = await uploadLogo(
      confirmRequest(`http://localhost?t=${token}`, { url: `https://blob.test/sponsors/${sponsorId}/logo.png`, fileName: 'logo.png', fileType: 'image/png', fileSize: 100 }),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(200);

    const getRes = await getSponsor(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const data = await getRes.json();
    expect(data.currentAsset?.fileName).toBe('logo.png');
  });

  // AUDIT: si el admin ya había marcado los materiales como revisados y el
  // sponsor sube un logo distinto, la revisión anterior queda obsoleta — debe
  // volver a PENDIENTE_REVISION en vez de dejar "LISTO_PARA_GENERAR" con un
  // archivo que nadie ha visto todavía.
  it('vuelve a poner en revisión un sponsor ya marcado como listo si se cambia el logo', async () => {
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'LISTO_PARA_GENERAR', guidedAnswers: { estilo: 'x' } } });
    const res = await uploadLogo(
      confirmRequest(`http://localhost?t=${token}`, { url: `https://blob.test/sponsors/${sponsorId}/logo-v2.png`, fileName: 'logo-v2.png', fileType: 'image/png', fileSize: 100 }),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(200);
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.status).toBe('PENDIENTE_REVISION');
  });

  it('rechaza confirmar un logo si la solicitud ya está aprobada o rechazada', async () => {
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'APROBADO_PARA_VIDEO' } });
    const res = await uploadLogo(
      confirmRequest(`http://localhost?t=${token}`, { url: `https://blob.test/sponsors/${sponsorId}/logo.png`, fileName: 'logo.png', fileType: 'image/png', fileSize: 100 }),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(409);
  });
});

// AUDIT: subir un segundo archivo (ej. logo + vídeo corto de referencia) no
// debe perder el primero — antes solo se exponía `currentAsset` (el más
// reciente), así que el sponsor no podía tener varios materiales a la vez.
describe('varios archivos coexisten (no se reemplazan)', () => {
  let sponsorRequestId: string;
  let sponsorId: string;
  let token: string;

  beforeAll(async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Multi Materiales SL',
        contactName: 'Titular Multi',
        email: 'sponsor-multi-test@example.com',
        sponsorType: 'evento',
        status: 'ACCEPTED',
      },
    });
    sponsorRequestId = request.id;
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId } });
    sponsorId = sponsor.id;
    token = signSponsorAccess(sponsorId, sponsor.portalTokenVersion);
  });

  afterAll(async () => {
    await prisma.sponsorAsset.deleteMany({ where: { sponsorId } });
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: sponsorRequestId } });
  });

  it('el GET devuelve todos los archivos subidos, no solo el último', async () => {
    await uploadLogo(
      confirmRequest(`http://localhost?t=${token}`, { url: `https://blob.test/sponsors/${sponsorId}/logo.png`, fileName: 'logo.png', fileType: 'image/png', fileSize: 100 }),
      { params: { sponsorId } }
    );
    await uploadLogo(
      confirmRequest(`http://localhost?t=${token}`, { url: `https://blob.test/sponsors/${sponsorId}/referencia.mp4`, fileName: 'referencia.mp4', fileType: 'video/mp4', fileSize: 200 }),
      { params: { sponsorId } }
    );

    const res = await getSponsor(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const data = await res.json();
    expect(data.assets).toHaveLength(2);
    const fileNames = data.assets.map((a: { fileName: string }) => a.fileName).sort();
    expect(fileNames).toEqual(['logo.png', 'referencia.mp4']);
  });
});
