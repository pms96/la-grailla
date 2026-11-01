export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { isOwnerAdmin } from '@/lib/access-roles';
import { checkTemporadaAbiertaTx, parseMotivo } from '@/lib/contabilidad/control';
import { fechaDiaSchema, importeSchema, parseFechaDia } from '@/lib/contabilidad/validation';
import { actorFromSession, diffFields, recordAdminAudit } from '@/lib/admin-audit';

const INGRESO_AUDIT_FIELDS = ['concepto', 'importe', 'fecha', 'notas'] as const;

const updateIngresoSchema = z.object({
  concepto: z.string().min(1).optional(),
  // H-140/H-055: igual que en el alta (un campo vacío o fuera de rango es un error, no un 0 ni un 500).
  importe: importeSchema.optional(),
  fecha: fechaDiaSchema.optional(),
  notas: z.string().optional().nullable(),
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
    const body = updateIngresoSchema.parse(await request.json());
    const before = await prisma.ingreso.findUnique({ where: { id: params?.id } });
    if (!before) return NextResponse.json({ error: 'Ingreso no encontrado' }, { status: 404 });
    if (before.voidedAt) return NextResponse.json({ error: 'Este ingreso está anulado y ya no se puede modificar', code: 'anulado' }, { status: 409 });
    const data: Prisma.IngresoUpdateInput = {};
    if (body.concepto !== undefined) data.concepto = body.concepto;
    if (body.importe !== undefined) data.importe = body.importe;
    if (body.fecha !== undefined) data.fecha = parseFechaDia(body.fecha) ?? undefined;
    if (body.notas !== undefined) data.notas = body.notas || null;

    const outcome = await prisma.$transaction(async (tx) => {
      // La temporada se comprueba DENTRO de la transacción y con la fila bloqueada (H-014): un cierre en curso no deja pasar este cambio.
      const open = await checkTemporadaAbiertaTx(tx, before.temporadaId);
      if (!open.ok) return NextResponse.json({ error: open.error, code: open.code }, { status: open.status });
      const updated = await tx.ingreso.update({ where: { id: params?.id }, data });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'ingreso.update',
        targetType: 'Ingreso',
        targetId: updated.id,
        meta: { temporadaId: updated.temporadaId, cambios: diffFields(before, updated, INGRESO_AUDIT_FIELDS) },
      });
      return updated;
    });
    return outcome instanceof NextResponse ? outcome : NextResponse.json(outcome);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/ingresos/[id]');
  }
}

/** Anular un ingreso (ya no se borra): solo el propietario, con motivo y con la temporada abierta. */
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!isOwnerAdmin(session)) return NextResponse.json({ error: 'Solo el propietario puede anular ingresos' }, { status: 403 });
  try {
    const motivo = parseMotivo(((await request.json().catch(() => null)) as { motivo?: unknown } | null)?.motivo);
    if (!motivo.ok) return NextResponse.json({ error: motivo.error }, { status: 400 });
    const before = await prisma.ingreso.findUnique({ where: { id: params?.id } });
    if (!before) return NextResponse.json({ error: 'Ingreso no encontrado' }, { status: 404 });
    if (before.voidedAt) return NextResponse.json({ error: 'Este ingreso ya está anulado', code: 'anulado' }, { status: 409 });
    const claimed = await prisma.$transaction(async (tx) => {
      const open = await checkTemporadaAbiertaTx(tx, before.temporadaId);
      if (!open.ok) return NextResponse.json({ error: open.error, code: open.code }, { status: open.status });
      // UPDATE condicionado a «aún no anulado» (compare-and-swap) dentro de la transacción: dos anulaciones simultáneas no pueden pisarse ni duplicar el rastro (H-009).
      const claim = await tx.ingreso.updateMany({
        where: { id: before.id, voidedAt: null },
        data: { voidedAt: new Date(), voidedById: session.user?.id ?? null, voidReason: motivo.motivo },
      });
      if (claim.count === 0) return false;
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'ingreso.void',
        targetType: 'Ingreso',
        targetId: before.id,
        meta: { motivo: motivo.motivo, temporadaId: before.temporadaId, concepto: before.concepto, importe: before.importe, fecha: before.fecha },
      });
      return true;
    });
    if (claimed instanceof NextResponse) return claimed;
    if (!claimed) return NextResponse.json({ error: 'Este ingreso ya está anulado', code: 'anulado' }, { status: 409 });
    return NextResponse.json({ success: true, voided: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/ingresos/[id]');
  }
}
