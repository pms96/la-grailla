export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { sanitizeUploadFileName } from '@/lib/blob-url';
import { tenantBlobPrefix } from '@/lib/tenant/blob';
import type { ModuleKey } from '@grailla/contracts';

const MAX_SIZE_BYTES = 5 * 1024 * 1024;

// H-068: cada carpeta de subida pertenece a un módulo. Un rol restringido solo sube a las de SUS módulos (y a ninguna sin dueño); el propietario, a cualquiera.
// Antes la ruta estaba abierta a todo administrador y cualquier rol podía llenar el almacén público.
const PREFIX_OWNER: Record<string, ModuleKey> = {
  brand: 'nucleo',
  sections: 'nucleo',
  events: 'entradas',
  products: 'tienda',
  'compras-listados': 'contabilidad',
};

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const prefix = String(formData.get('prefix') ?? 'uploads').replace(/[^a-z0-9-]/gi, '') || 'uploads';

    const modules = session.user.modules ?? null;
    const owner = PREFIX_OWNER[prefix];
    if (modules !== null && (!owner || !modules.includes(owner))) {
      return NextResponse.json({ error: 'Sin permiso para subir a esta carpeta' }, { status: 403 });
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No se ha recibido ningún archivo' }, { status: 400 });
    }
    if (!file.type?.startsWith('image/')) {
      return NextResponse.json({ error: 'Solo se permiten imágenes' }, { status: 400 });
    }
    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: 'La imagen no puede superar 5MB' }, { status: 400 });
    }

    const blob = await put(`${tenantBlobPrefix()}${prefix}/${crypto.randomUUID()}-${sanitizeUploadFileName(file.name)}`, file, {
      access: 'public',
      addRandomSuffix: false,
    });

    return NextResponse.json({ url: blob.url });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/upload');
  }
}
