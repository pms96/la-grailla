export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const editPromptSchema = z.object({
  promptEs: z.string().min(1),
  promptEn: z.string().min(1),
});

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = editPromptSchema.parse(await request.json());
    const existing = await prisma.sponsorVideoPrompt.findUnique({ where: { sponsorId: params?.id } });
    if (!existing) {
      return NextResponse.json({ error: 'Este sponsor todavía no tiene un prompt generado' }, { status: 404 });
    }
    // Editar un prompt ya aprobado deja esa aprobación obsoleta — se limpia
    // approvedAt/notifiedAt para que quede claro que hay que revisar/aprobar
    // de nuevo antes de dar el prompt por bueno.
    const wasApproved = Boolean(existing.approvedAt);
    const updated = await prisma.sponsorVideoPrompt.update({
      where: { sponsorId: params?.id },
      data: {
        promptEs: body.promptEs,
        promptEn: body.promptEn,
        ...(wasApproved ? { approvedAt: null, approvedById: null, notifiedAt: null } : {}),
      },
    });
    return NextResponse.json(updated);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/sponsors-portal/[id]/prompt');
  }
}
