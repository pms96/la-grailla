export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateGastoSchema = z.object({
  categoria: z.string().min(1).optional(),
  concepto: z.string().min(1).optional(),
  proveedorId: z.string().optional().nullable(),
  importeSinIva: z.coerce.number().optional(),
  ivaPercent: z.coerce.number().optional(),
  fecha: z.string().optional(),
  numDocumento: z.string().optional().nullable(),
  tipoDocumento: z.string().optional(),
  notas: z.string().optional().nullable(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
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

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateGastoSchema.parse(await request.json());
    const data: Prisma.GastoUpdateInput = {};
    if (body.categoria !== undefined) data.categoria = body.categoria;
    if (body.concepto !== undefined) data.concepto = body.concepto;
    if (body.proveedorId !== undefined) data.proveedor = body.proveedorId ? { connect: { id: body.proveedorId } } : { disconnect: true };
    if (body.importeSinIva !== undefined) data.importeSinIva = body.importeSinIva;
    if (body.ivaPercent !== undefined) data.ivaPercent = body.ivaPercent;
    if (body.fecha !== undefined) data.fecha = new Date(body.fecha);
    if (body.numDocumento !== undefined) data.numDocumento = body.numDocumento || null;
    if (body.tipoDocumento !== undefined) data.tipoDocumento = body.tipoDocumento;
    if (body.notas !== undefined) data.notas = body.notas || null;

    const gasto = await prisma.gasto.update({ where: { id: params?.id }, data, include: { proveedor: true, pedido: true } });
    return NextResponse.json(gasto);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/gastos/[id]');
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    await prisma.gasto.delete({ where: { id: params?.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/gastos/[id]');
  }
}
