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
import { fechaDiaSchema, importeSchema, ivaPercentSchema, parseFechaDia } from '@/lib/contabilidad/validation';
import { actorFromSession, diffFields, recordAdminAudit } from '@/lib/admin-audit';

const GASTO_AUDIT_FIELDS = ['categoria', 'concepto', 'proveedorId', 'importeSinIva', 'ivaPercent', 'fecha', 'numDocumento', 'tipoDocumento', 'notas'] as const;

const updateGastoSchema = z.object({
  categoria: z.string().min(1).optional(),
  concepto: z.string().min(1).optional(),
  proveedorId: z.string().optional().nullable(),
  // H-140/H-055: igual que en el alta (un campo vacío o fuera de rango es un error, no un 0 ni un 500).
  importeSinIva: importeSchema.optional(),
  ivaPercent: ivaPercentSchema.optional(),
  fecha: fechaDiaSchema.optional(),
  numDocumento: z.string().optional().nullable(),
  tipoDocumento: z.string().optional(),
  notas: z.string().optional().nullable(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN' ? session : null;
}

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const gasto = await prisma.gasto.findUnique({
      where: { id: params?.id },
      include: { proveedor: true, pedido: true, temporada: true },
    });
    if (!gasto) return NextResponse.json({ error: 'Gasto no encontrado' }, { status: 404 });
    return NextResponse.json(gasto);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/gastos/[id]');
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateGastoSchema.parse(await request.json());
    const before = await prisma.gasto.findUnique({ where: { id: params?.id } });
    if (!before) return NextResponse.json({ error: 'Gasto no encontrado' }, { status: 404 });
    if (before.voidedAt) return NextResponse.json({ error: 'Este gasto está anulado y ya no se puede modificar', code: 'anulado' }, { status: 409 });
    const data: Prisma.GastoUpdateInput = {};
    if (body.categoria !== undefined) data.categoria = body.categoria;
    if (body.concepto !== undefined) data.concepto = body.concepto;
    if (body.proveedorId !== undefined) data.proveedor = body.proveedorId ? { connect: { id: body.proveedorId } } : { disconnect: true };
    if (body.importeSinIva !== undefined) data.importeSinIva = body.importeSinIva;
    if (body.ivaPercent !== undefined) data.ivaPercent = body.ivaPercent;
    if (body.fecha !== undefined) data.fecha = parseFechaDia(body.fecha) ?? undefined;
    if (body.numDocumento !== undefined) data.numDocumento = body.numDocumento || null;
    if (body.tipoDocumento !== undefined) data.tipoDocumento = body.tipoDocumento;
    if (body.notas !== undefined) data.notas = body.notas || null;

    const outcome = await prisma.$transaction(async (tx) => {
      // La temporada se comprueba DENTRO de la transacción y con la fila bloqueada (H-014): un cierre en curso no deja pasar este cambio.
      const open = await checkTemporadaAbiertaTx(tx, before.temporadaId);
      if (!open.ok) return NextResponse.json({ error: open.error, code: open.code }, { status: open.status });
      const updated = await tx.gasto.update({ where: { id: params?.id }, data, include: { proveedor: true, pedido: true } });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'gasto.update',
        targetType: 'Gasto',
        targetId: updated.id,
        meta: { temporadaId: updated.temporadaId, cambios: diffFields(before, updated, GASTO_AUDIT_FIELDS) },
      });
      return updated;
    });
    return outcome instanceof NextResponse ? outcome : NextResponse.json(outcome);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/gastos/[id]');
  }
}

/** Anular un gasto (ya no se borra): solo el propietario, con motivo y con la temporada abierta. El gasto sigue en la BD, fuera de todas las cifras. */
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!isOwnerAdmin(session)) return NextResponse.json({ error: 'Solo el propietario puede anular gastos' }, { status: 403 });
  try {
    const motivo = parseMotivo(((await request.json().catch(() => null)) as { motivo?: unknown } | null)?.motivo);
    if (!motivo.ok) return NextResponse.json({ error: motivo.error }, { status: 400 });
    const before = await prisma.gasto.findUnique({ where: { id: params?.id } });
    if (!before) return NextResponse.json({ error: 'Gasto no encontrado' }, { status: 404 });
    if (before.voidedAt) return NextResponse.json({ error: 'Este gasto ya está anulado', code: 'anulado' }, { status: 409 });
    const claimed = await prisma.$transaction(async (tx) => {
      const open = await checkTemporadaAbiertaTx(tx, before.temporadaId);
      if (!open.ok) return NextResponse.json({ error: open.error, code: open.code }, { status: open.status });
      // Se reclama con un UPDATE condicionado a «aún no anulado» (compare-and-swap) DENTRO de la transacción: dos anulaciones simultáneas pasaban la
      // comprobación de arriba y la segunda pisaba motivo y autor y duplicaba el rastro (H-009).
      // Se suelta el vínculo con el pedido (es único): así ese pedido puede volver a registrarse. El vínculo anterior queda en el rastro.
      const claim = await tx.gasto.updateMany({
        where: { id: before.id, voidedAt: null },
        data: { voidedAt: new Date(), voidedById: session.user?.id ?? null, voidReason: motivo.motivo, pedidoId: null },
      });
      if (claim.count === 0) return false;
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'gasto.void',
        targetType: 'Gasto',
        targetId: before.id,
        meta: {
          motivo: motivo.motivo,
          temporadaId: before.temporadaId,
          categoria: before.categoria,
          concepto: before.concepto,
          importeSinIva: before.importeSinIva,
          ivaPercent: before.ivaPercent,
          numDocumento: before.numDocumento,
          pedidoId: before.pedidoId,
        },
      });
      return true;
    });
    if (claimed instanceof NextResponse) return claimed;
    if (!claimed) return NextResponse.json({ error: 'Este gasto ya está anulado', code: 'anulado' }, { status: 409 });
    return NextResponse.json({ success: true, voided: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/gastos/[id]');
  }
}
