export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getAbacusAIProvider } from '@/lib/abacus-ai-adapter';

const extraerSchema = z.object({ imageUrl: z.string().url() });

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { imageUrl } = extraerSchema.parse(await request.json());
    const provider = await getAbacusAIProvider();
    const { items } = await provider.extractArticulosFromImage({ imageUrl });
    return NextResponse.json({ items });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/compras/articulos/extraer-imagen');
  }
}
