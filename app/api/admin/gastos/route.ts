export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { madridDayKey } from '@/lib/ventas-por-dia';
import { Prisma } from '@prisma/client';
import { checkTemporadaAbiertaTx } from '@/lib/contabilidad/control';
import { fechaDiaSchema, importeSchema, ivaPercentSchema, parseFechaDia } from '@/lib/contabilidad/validation';
import { actorFromSession, recordAdminAudit } from '@/lib/admin-audit';

const createGastoSchema = z.object({
  temporadaId: z.string().min(1),
  categoria: z.string().min(1),
  concepto: z.string().min(1),
  proveedorId: z.string().optional().nullable(),
  pedidoId: z.string().optional().nullable(),
  // H-140/H-055: sin esto un campo vacío era un 0 silencioso, el IVA no tenía rango y la fecha era texto libre. `fecha: ""` sigue siendo «sin fecha» (H-001).
  importeSinIva: importeSchema,
  ivaPercent: ivaPercentSchema.default(21),
  fecha: z.union([z.literal(''), fechaDiaSchema]).optional(),
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
    // El gasto y su rastro de auditoría se escriben juntos: no puede haber un gasto nuevo sin registro de quién lo creó. La temporada se comprueba DENTRO
    // de la transacción y con la fila bloqueada (H-014): un cierre en curso no puede dejar un gasto nuevo en unos libros cerrados.
    const outcome = await prisma.$transaction(async (tx) => {
      const open = await checkTemporadaAbiertaTx(tx, body.temporadaId);
      if (!open.ok) return NextResponse.json({ error: open.error, code: open.code }, { status: open.status });
      if (body.pedidoId) {
        const pedido = await tx.pedido.findUnique({ where: { id: body.pedidoId }, select: { temporadaId: true, gasto: { select: { id: true } } } });
        if (!pedido) return NextResponse.json({ error: 'El pedido no existe', code: 'pedido_no_encontrado' }, { status: 404 });
        if (pedido.temporadaId !== body.temporadaId) {
          return NextResponse.json({ error: 'Ese pedido es de otra temporada: el gasto debe ir en la misma que su pedido', code: 'pedido_otra_temporada' }, { status: 400 });
        }
        if (pedido.gasto) return NextResponse.json({ error: 'Este pedido ya tiene su gasto registrado', code: 'pedido_ya_registrado' }, { status: 409 });
      }
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
          fecha: (body.fecha ? parseFechaDia(body.fecha) : null) ?? new Date(madridDayKey(new Date())), // una fecha vacía ("") también es «sin fecha» (H-001)
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
    return outcome instanceof NextResponse ? outcome : NextResponse.json(outcome);
  } catch (error) {
    // Doble envío del formulario: el único de `pedidoId` frena la segunda alta aunque las dos pasaran la comprobación de arriba.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'Este pedido ya tiene su gasto registrado', code: 'pedido_ya_registrado' }, { status: 409 });
    }
    return handleApiError(error, 'POST /api/admin/gastos');
  }
}
