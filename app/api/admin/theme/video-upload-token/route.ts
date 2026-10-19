export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { HERO_VIDEO_MAX_BYTES, HERO_VIDEO_TYPES, isHeroVideoPath } from '@/lib/brand/hero-video';
import { tenantBlobPrefix } from '@/lib/tenant/blob';

// Emite el token con el que el administrador sube el vídeo de cabecera DIRECTAMENTE a Vercel Blob desde el navegador (igual que el vídeo final de
// Sponsors): el binario no pasa por esta API, así que no choca con el límite de payload de las funciones serverless. El servidor solo permite la
// carpeta del cliente, MP4 o WebM y hasta el tamaño máximo.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!isHeroVideoPath(pathname, tenantBlobPrefix())) throw new Error('Ruta de archivo no permitida');
        return {
          allowedContentTypes: Array.from(HERO_VIDEO_TYPES),
          maximumSizeInBytes: HERO_VIDEO_MAX_BYTES,
          addRandomSuffix: false,
        };
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/theme/video-upload-token');
  }
}
