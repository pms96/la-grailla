export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { madridDayKey } from '@/lib/ventas-por-dia';
import { checkTemporadaAbierta } from '@/lib/contabilidad/control';
import { actorFromSession, recordAdminAudit } from '@/lib/admin-audit';

const createGastoSchema = z.object({
  temporadaId: z.string().min(1),
  categoria: z.string().min(1),
  concepto: z.string().min(1),
  proveedorId: z.string().optional().nullable(),
  pedidoId: z.string().optional().nullable(),
  importeSinIva: z.coerce.number(),
  ivaPercent: z.coerce.number().default(21),
  fecha: z.string().optional(),
  numDocumento: z.string().optional().nullable(),
  tipoDocumento: z.string().default('Factura'),
  notas: z.string().optional().nullable(),
});

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const temporadaId = searchParams.get('temporadaId');
    const categoria = searchParams.get('categoria');
    const proveedorId = searchParams.get('proveedorId');
    // Los gastos anulados no cuentan en ninguna cifra; solo se listan si se piden (`?anulados=1`) para revisarlos.
    const incluirAnulados = searchParams.get('anulados') === '1';

    const gastos = await prisma.gasto.findMany({
      where: {
        ...(incluirAnulados ? {} : { voidedAt: null }),
        ...(temporadaId && { temporadaId }),
        ...(categoria && { categoria }),
        ...(proveedorId && { proveedorId }),
      },
      orderBy: { fecha: 'desc' },
      include: { proveedor: true, pedido: true, createdBy: { select: { id: true, name: true, email: true } } },
    });
    return NextResponse.json(gastos ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/gastos');
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createGastoSchema.parse(await request.json());
    const open = await checkTemporadaAbierta(body.temporadaId);
    if (!open.ok) return NextResponse.json({ error: open.error, code: open.code }, { status: open.status });
    // El gasto y su rastro de auditoría se escriben juntos: no puede haber un gasto nuevo sin registro de quién lo creó.
    const gasto = await prisma.$transaction(async (tx) => {
      const created = await tx.gasto.create({
        data: {
          temporadaId: body.temporadaId,
          categoria: body.categoria,
          concepto: body.concepto,
          proveedorId: body.proveedorId || null,
          pedidoId: body.pedidoId || null,
          importeSinIva: body.importeSinIva,
          ivaPercent: body.ivaPercent,
          // Sin fecha: el día natural de Madrid como medianoche UTC (el formato de las demás filas), no el instante actual.
          fecha: new Date(body.fecha || madridDayKey(new Date())), // `||`: una fecha vacía ("") también es «sin fecha» (H-001)
          numDocumento: body.numDocumento || null,
          tipoDocumento: body.tipoDocumento,
          notas: body.notas || null,
          createdById: session.user?.id,
        },
        include: { proveedor: true, pedido: true },
      });
      await recordAdminAudit(tx, actorFromSession(session), request, {
        action: 'gasto.create',
        targetType: 'Gasto',
        targetId: created.id,
        meta: {
          temporadaId: created.temporadaId,
          categoria: created.categoria,
          concepto: created.concepto,
          importeSinIva: created.importeSinIva,
          ivaPercent: created.ivaPercent,
          numDocumento: created.numDocumento,
        },
      });
      return created;
    });
    return NextResponse.json(gasto);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/gastos');
  }
}
