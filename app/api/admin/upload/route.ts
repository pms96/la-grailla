export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const MAX_SIZE_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const prefix = String(formData.get('prefix') ?? 'uploads').replace(/[^a-z0-9-]/gi, '') || 'uploads';

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No se ha recibido ningún archivo' }, { status: 400 });
    }
    if (!file.type?.startsWith('image/')) {
      return NextResponse.json({ error: 'Solo se permiten imágenes' }, { status: 400 });
    }
    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: 'La imagen no puede superar 5MB' }, { status: 400 });
    }

    const blob = await put(`${prefix}/${crypto.randomUUID()}-${file.name}`, file, {
      access: 'public',
      addRandomSuffix: false,
    });

    return NextResponse.json({ url: blob.url });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/upload');
  }
}
