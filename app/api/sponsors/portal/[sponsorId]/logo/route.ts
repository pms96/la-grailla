export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';
import { nextStatusAfterEdit } from '@/lib/sponsor-portal';
import { ALLOWED_SPONSOR_MATERIAL_TYPES } from '@/lib/sponsor-uploads';

// El archivo ya se ha subido directamente del navegador a Vercel Blob (ver
// upload-token/route.ts) — aquí solo se confirma y se persiste como
// SponsorAsset. Subir el binario a través de esta ruta (como antes) chocaba
// con el límite de payload de las funciones serverless de Vercel (~4.5MB),
// rompiendo cualquier vídeo de referencia real.
const confirmSchema = z.object({
  url: z.string().url(),
  fileName: z.string().min(1).max(255),
  fileType: z.string().min(1),
  fileSize: z.number().int().positive(),
});

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

    const body = confirmSchema.parse(await request.json());
    if (!ALLOWED_SPONSOR_MATERIAL_TYPES.has(body.fileType)) {
      return NextResponse.json({ error: 'Formato no admitido.' }, { status: 400 });
    }
    // El token de subida ya restringía la ruta a sponsors/{sponsorId}/ — esto
    // es una comprobación extra de que la URL confirmada es la que de verdad
    // se generó para este sponsor (evita que alguien cuele la URL de otro).
    if (!body.url.includes(`/sponsors/${sponsorId}/`)) {
      return NextResponse.json({ error: 'Archivo inválido' }, { status: 400 });
    }

    const asset = await prisma.sponsorAsset.create({
      data: {
        sponsorId,
        url: body.url,
        fileType: body.fileType,
        fileName: body.fileName,
        fileSize: body.fileSize,
      },
    });

    const nextStatus = nextStatusAfterEdit(sponsor.status, true, Boolean(sponsor.guidedAnswers));
    await prisma.sponsor.update({
      where: { id: sponsorId },
      data: { currentAssetId: asset.id, status: nextStatus },
    });

    return NextResponse.json({ asset, status: nextStatus });
  } catch (error) {
    return handleApiError(error, 'POST /api/sponsors/portal/[sponsorId]/logo');
  }
}
