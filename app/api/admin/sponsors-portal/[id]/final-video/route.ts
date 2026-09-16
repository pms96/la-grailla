export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { put, del } from '@vercel/blob';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

// El vídeo final ya producido (no el de referencia que sube el sponsor, ni
// la propuesta generada por IA) — lo sube el admin a mano cuando está
// terminado. Un único slot por sponsor: cada subida reemplaza a la anterior.
const ALLOWED_TYPES: Record<string, number> = {
  'video/mp4': 200 * 1024 * 1024,
  'video/quicktime': 200 * 1024 * 1024,
  'video/webm': 200 * 1024 * 1024,
};

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsor = await prisma.sponsor.findUnique({ where: { id: params?.id } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No se ha recibido ningún archivo' }, { status: 400 });
    }

    const maxSize = ALLOWED_TYPES[file.type];
    if (!maxSize) {
      return NextResponse.json({ error: 'Formato no admitido. Usa MP4, MOV o WebM.' }, { status: 400 });
    }
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `El archivo supera el tamaño máximo permitido (${Math.round(maxSize / (1024 * 1024))}MB).` },
        { status: 400 }
      );
    }

    const blob = await put(`sponsors/${sponsor.id}/final-video/${crypto.randomUUID()}-${file.name}`, file, {
      access: 'public',
      addRandomSuffix: false,
    });

    const previousUrl = sponsor.finalVideoUrl;
    const updated = await prisma.sponsor.update({
      where: { id: sponsor.id },
      data: {
        finalVideoUrl: blob.url,
        finalVideoFileName: file.name,
        finalVideoSize: file.size,
        finalVideoUploadedAt: new Date(),
      },
    });

    if (previousUrl) {
      await del(previousUrl).catch(() => {});
    }

    return NextResponse.json(updated);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/final-video');
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsor = await prisma.sponsor.findUnique({ where: { id: params?.id } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    if (!sponsor.finalVideoUrl) {
      return NextResponse.json({ error: 'Este sponsor no tiene vídeo final' }, { status: 404 });
    }

    const updated = await prisma.sponsor.update({
      where: { id: sponsor.id },
      data: { finalVideoUrl: null, finalVideoFileName: null, finalVideoSize: null, finalVideoUploadedAt: null },
    });

    await del(sponsor.finalVideoUrl).catch(() => {});

    return NextResponse.json(updated);
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/sponsors-portal/[id]/final-video');
  }
}
