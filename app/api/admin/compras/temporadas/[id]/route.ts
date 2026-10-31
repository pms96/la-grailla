export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { isOwnerAdmin } from '@/lib/access-roles';
import { parseMotivo, temporadaCerrada } from '@/lib/contabilidad/control';
import { actorFromSession, diffFields, recordAdminAudit } from '@/lib/admin-audit';

const TEMPORADA_AUDIT_FIELDS = ['nombre', 'anio', 'fechaInicio', 'fechaFin', 'status', 'notas', 'archivado'] as const;

const updateTemporadaSchema = z.object({
  nombre: z.string().min(1).optional(),
  anio: z.coerce.number().int().optional(),
  fechaInicio: z.string().optional().nullable(),
  fechaFin: z.string().optional().nullable(),
  status: z.enum(['ABIERTA', 'CERRADA']).optional(),
  notas: z.string().optional().nullable(),
  archivado: z.boolean().optional(),
  // Motivo de la reapertura (obligatorio al pasar de CERRADA a ABIERTA); al cerrar es opcional y queda en el registro.
  motivo: z.string().optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN' ? session : null;
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateTemporadaSchema.parse(await request.json());
    const before = await prisma.temporada.findUnique({ where: { id: params?.id } });
    if (!before) return NextResponse.json({ error: 'Temporada no encontrada' }, { status: 404 });

    // Cerrar y reabrir protege los libros ya presentados: solo el propietario, y reabrir exige motivo.
    const closing = body.status === 'CERRADA' && !temporadaCerrada(before);
    const reopening = body.status === 'ABIERTA' && temporadaCerrada(before);
    let motivo: string | null = null;
    if (closing || reopening) {
      if (!isOwnerAdmin(session)) return NextResponse.json({ error: 'Solo el propietario puede cerrar o reabrir una temporada' }, { status: 403 });
      if (reopening) {
        const parsed = parseMotivo(body.motivo);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        motivo = parsed.motivo;
      } else if (body.motivo?.trim()) {
        motivo = body.motivo.trim().slice(0, 300);
      }
    }
    // Cerrada: solo se puede archivar o reabrir. Cambiar nombre, año o fechas de unos libros cerrados es justo lo que se quiere evitar.
    if (temporadaCerrada(before) && !reopening) {
      const editsOthers = ['nombre', 'anio', 'fechaInicio', 'fechaFin', 'notas'].some((k) => (body as Record<string, unknown>)[k] !== undefined);
      if (editsOthers) {
        return NextResponse.json({ error: 'La temporada está cerrada: reábrela (con motivo) para cambiar sus datos.', code: 'temporada_cerrada' }, { status: 423 });
      }
    }

    const data: Prisma.TemporadaUpdateInput = {};
    if (closing) {
      data.closedAt = new Date();
      data.closedById = session.user?.id ?? null;
    } else if (reopening) {
      data.closedAt = null;
      data.closedById = null;
    }
    if (body.nombre !== undefined) data.nombre = body.nombre;
    if (body.anio !== undefined) data.anio = body.anio;
    if (body.fechaInicio !== undefined) data.fechaInicio = body.fechaInicio ? new Date(body.fechaInicio) : null;
    if (body.fechaFin !== undefined) data.fechaFin = body.fechaFin ? new Date(body.fechaFin) : null;
    if (body.status !== undefined) data.status = body.status;
    if (body.notas !== undefined) data.notas = body.notas || null;
    if (body.archivado !== undefined) data.archivado = body.archivado;

    const temporada = await prisma.$transaction(async (tx) => {
      const updated = await tx.temporada.update({ where: { id: params?.id }, data });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: closing ? 'temporada.close' : reopening ? 'temporada.reopen' : 'temporada.update',
        targetType: 'Temporada',
        targetId: updated.id,
        meta: { nombre: updated.nombre, ...(motivo ? { motivo } : {}), cambios: diffFields(before, updated, TEMPORADA_AUDIT_FIELDS) },
      });
      return updated;
    });
    return NextResponse.json(temporada);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/compras/temporadas/[id]');
  }
}
