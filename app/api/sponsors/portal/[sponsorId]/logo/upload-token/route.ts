export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';
import { rateLimit } from '@/lib/rate-limit';
import { ALLOWED_SPONSOR_MATERIAL_TYPES, MAX_SPONSOR_MATERIAL_SIZE } from '@/lib/sponsor-uploads';

// Emite el token con el que el navegador sube el archivo DIRECTAMENTE a
// Vercel Blob, sin pasar el binario por esta función — necesario porque las
// funciones serverless de Vercel rechazan payloads de más de ~4.5MB con un
// 413 (texto plano, no JSON), lo que antes rompía cualquier vídeo real aunque
// estuviera dentro del límite que anunciábamos nosotros mismos (50MB).
export async function POST(request: Request, { params }: { params: { sponsorId: string } }) {
  try {
    const sponsorId = params?.sponsorId;
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    if (!(await allowSponsorAccess(sponsorId, sponsor.portalTokenVersion, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    if (sponsor.status === 'APROBADO_PARA_VIDEO' || sponsor.status === 'RECHAZADO') {
      return NextResponse.json(
        { error: 'Esta solicitud ya está cerrada — escríbenos si necesitas cambiar algo.' },
        { status: 409 }
      );
    }
    const limit = await rateLimit('sponsor-portal-upload', sponsorId, 20, 60 * 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiadas subidas. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // El propio pathname lo elige el cliente antes de pedir el token —
        // se restringe aquí a la carpeta de ESTE sponsor (mismo criterio
        // IDOR que allowSponsorAccess de arriba).
        if (!pathname.startsWith(`sponsors/${sponsorId}/`)) {
          throw new Error('Ruta de archivo no permitida');
        }
        return {
          allowedContentTypes: Array.from(ALLOWED_SPONSOR_MATERIAL_TYPES),
          maximumSizeInBytes: MAX_SPONSOR_MATERIAL_SIZE,
          addRandomSuffix: false,
        };
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return handleApiError(error, 'POST /api/sponsors/portal/[sponsorId]/logo/upload-token');
  }
}
