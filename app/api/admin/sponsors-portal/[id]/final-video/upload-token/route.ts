export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { ALLOWED_FINAL_VIDEO_TYPES, MAX_FINAL_VIDEO_SIZE } from '@/lib/sponsor-uploads';

// Emite el token con el que el admin sube el vídeo final DIRECTAMENTE a
// Vercel Blob desde el navegador — igual que en sponsors/portal/.../logo,
// necesario para no chocar con el límite de payload (~4.5MB) de las
// funciones serverless de Vercel al mandar el binario por esta API.
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

    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(`sponsors/${sponsor.id}/final-video/`)) {
          throw new Error('Ruta de archivo no permitida');
        }
        return {
          allowedContentTypes: Array.from(ALLOWED_FINAL_VIDEO_TYPES),
          maximumSizeInBytes: MAX_FINAL_VIDEO_SIZE,
          addRandomSuffix: false,
        };
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/final-video/upload-token');
  }
}
