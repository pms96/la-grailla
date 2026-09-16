export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { del } from '@vercel/blob';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

// El vídeo final ya producido (no el de referencia que sube el sponsor, ni
// la propuesta generada por IA) — lo sube el admin a mano cuando está
// terminado. Un único slot por sponsor: cada subida reemplaza a la anterior.
// El binario se sube directamente del navegador a Vercel Blob (ver
// upload-token/route.ts) — esta ruta solo confirma y persiste el resultado.
const confirmSchema = z.object({
  url: z.string().url(),
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
});

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

    const body = confirmSchema.parse(await request.json());
    if (!body.url.includes(`/sponsors/${sponsor.id}/final-video/`)) {
      return NextResponse.json({ error: 'Archivo inválido' }, { status: 400 });
    }

    const previousUrl = sponsor.finalVideoUrl;
    const updated = await prisma.sponsor.update({
      where: { id: sponsor.id },
      data: {
        finalVideoUrl: body.url,
        finalVideoFileName: body.fileName,
        finalVideoSize: body.fileSize,
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
