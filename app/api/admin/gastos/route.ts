export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

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

    const gastos = await prisma.gasto.findMany({
      where: {
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
    const gasto = await prisma.gasto.create({
      data: {
        temporadaId: body.temporadaId,
        categoria: body.categoria,
        concepto: body.concepto,
        proveedorId: body.proveedorId || null,
        pedidoId: body.pedidoId || null,
        importeSinIva: body.importeSinIva,
        ivaPercent: body.ivaPercent,
        fecha: body.fecha ? new Date(body.fecha) : new Date(),
        numDocumento: body.numDocumento || null,
        tipoDocumento: body.tipoDocumento,
        notas: body.notas || null,
        createdById: session.user?.id,
      },
      include: { proveedor: true, pedido: true },
    });
    return NextResponse.json(gasto);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/gastos');
  }
}
