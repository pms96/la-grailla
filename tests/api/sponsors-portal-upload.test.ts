import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { signSponsorAccess } from '@/lib/access-token';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => null),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (key: string) => ({ url: `https://blob.test/${key}` })),
}));

const { POST: uploadLogo } = await import('@/app/api/sponsors/portal/[sponsorId]/logo/route');
const { GET: getSponsor } = await import('@/app/api/sponsors/portal/[sponsorId]/route');

function multipartRequest(url: string, file: File): Request {
  const formData = new FormData();
  formData.append('file', file);
  return new Request(url, { method: 'POST', body: formData });
}

describe('POST /api/sponsors/portal/[sponsorId]/logo', () => {
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
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    const res = await uploadLogo(multipartRequest('http://localhost', file), { params: { sponsorId } });
    expect(res.status).toBe(401);
  });

  // AUDIT: el sponsorId de la URL debe contrastarse contra el token — el
  // token de OTRO sponsor no debe permitir subir un archivo a este.
  it('rechaza el token de otro sponsor (IDOR)', async () => {
    const otherToken = signSponsorAccess('otro-sponsor-id', 1);
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    const res = await uploadLogo(
      multipartRequest(`http://localhost?t=${otherToken}`, file),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(401);
  });

  it('rechaza un tipo de archivo no permitido', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'malware.exe', { type: 'application/x-msdownload' });
    const res = await uploadLogo(
      multipartRequest(`http://localhost?t=${token}`, file),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(400);
  });

  it('rechaza un archivo que supera el tamaño máximo', async () => {
    const big = new Uint8Array(11 * 1024 * 1024); // 11MB > 10MB para imágenes
    const file = new File([big], 'logo.png', { type: 'image/png' });
    const res = await uploadLogo(
      multipartRequest(`http://localhost?t=${token}`, file),
      { params: { sponsorId } }
    );
    expect(res.status).toBe(400);
  });

  it('acepta un logo válido y lo deja como currentAsset', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    const res = await uploadLogo(
      multipartRequest(`http://localhost?t=${token}`, file),
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
    const file = new File([new Uint8Array([9, 9, 9])], 'logo-v2.png', { type: 'image/png' });
    const res = await uploadLogo(multipartRequest(`http://localhost?t=${token}`, file), { params: { sponsorId } });
    expect(res.status).toBe(200);
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.status).toBe('PENDIENTE_REVISION');
  });

  it('rechaza subir un logo si la solicitud ya está aprobada o rechazada', async () => {
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: 'APROBADO_PARA_VIDEO' } });
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    const res = await uploadLogo(multipartRequest(`http://localhost?t=${token}`, file), { params: { sponsorId } });
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
    const logo = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    await uploadLogo(multipartRequest(`http://localhost?t=${token}`, logo), { params: { sponsorId } });

    const reference = new File([new Uint8Array([4, 5, 6])], 'referencia.mp4', { type: 'video/mp4' });
    await uploadLogo(multipartRequest(`http://localhost?t=${token}`, reference), { params: { sponsorId } });

    const res = await getSponsor(new Request(`http://localhost?t=${token}`), { params: { sponsorId } });
    const data = await res.json();
    expect(data.assets).toHaveLength(2);
    const fileNames = data.assets.map((a: { fileName: string }) => a.fileName).sort();
    expect(fileNames).toEqual(['logo.png', 'referencia.mp4']);
  });
});
