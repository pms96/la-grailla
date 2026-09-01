export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { allowSponsorAccess, getTokenFromRequest } from '@/lib/access-token';
import { rateLimit } from '@/lib/rate-limit';
import { nextStatusAfterEdit } from '@/lib/sponsor-portal';

// Tamaño máximo por tipo — el vídeo de referencia pesa mucho más que un logo.
const ALLOWED_TYPES: Record<string, number> = {
  'image/png': 10 * 1024 * 1024,
  'image/jpeg': 10 * 1024 * 1024,
  'image/svg+xml': 10 * 1024 * 1024,
  'application/pdf': 10 * 1024 * 1024,
  'video/mp4': 50 * 1024 * 1024,
  'video/quicktime': 50 * 1024 * 1024,
};

export async function POST(request: Request, { params }: { params: { sponsorId: string } }) {
  try {
    const sponsorId = params?.sponsorId;
    if (!(await allowSponsorAccess(sponsorId, getTokenFromRequest(request)))) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const limit = await rateLimit('sponsor-portal-upload', sponsorId, 20, 60 * 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiadas subidas. Espera un momento.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    if (sponsor.status === 'APROBADO_PARA_VIDEO' || sponsor.status === 'RECHAZADO') {
      return NextResponse.json(
        { error: 'Esta solicitud ya está cerrada — escríbenos si necesitas cambiar algo.' },
        { status: 409 }
      );
    }

    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No se ha recibido ningún archivo' }, { status: 400 });
    }

    const maxSize = ALLOWED_TYPES[file.type];
    if (!maxSize) {
      return NextResponse.json(
        { error: 'Formato no admitido. Usa PNG, JPG, SVG, PDF o un vídeo corto (MP4/MOV).' },
        { status: 400 }
      );
    }
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `El archivo supera el tamaño máximo permitido (${Math.round(maxSize / (1024 * 1024))}MB).` },
        { status: 400 }
      );
    }

    const blob = await put(`sponsors/${sponsorId}/${crypto.randomUUID()}-${file.name}`, file, {
      access: 'public',
      addRandomSuffix: false,
    });

    const asset = await prisma.sponsorAsset.create({
      data: {
        sponsorId,
        url: blob.url,
        fileType: file.type,
        fileName: file.name,
        fileSize: file.size,
      },
    });

    const nextStatus = nextStatusAfterEdit(sponsor.status, true, Boolean(sponsor.guidedAnswers));
    await prisma.sponsor.update({
      where: { id: sponsorId },
      data: { currentAssetId: asset.id, status: nextStatus },
    });

    return NextResponse.json({ asset, status: nextStatus });
  } catch (error) {
    return handleApiError(error, 'POST /api/patrocinadores/[sponsorId]/logo');
  }
}
