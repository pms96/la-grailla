export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateProveedorSchema = z.object({
  nombre: z.string().min(1).optional(),
  contacto: z.string().optional().nullable(),
  telefono: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
  activo: z.boolean().optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const body = updateProveedorSchema.parse(await request.json());
    const data: Prisma.ProveedorUpdateInput = {};
    if (body.nombre !== undefined) data.nombre = body.nombre;
    if (body.contacto !== undefined) data.contacto = body.contacto || null;
    if (body.telefono !== undefined) data.telefono = body.telefono || null;
    if (body.email !== undefined) data.email = body.email || null;
    if (body.notas !== undefined) data.notas = body.notas || null;
    if (body.activo !== undefined) data.activo = body.activo;

    const proveedor = await prisma.proveedor.update({ where: { id: params?.id }, data });
    return NextResponse.json(proveedor);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/compras/proveedores/[id]');
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    await prisma.proveedor.update({ where: { id: params?.id }, data: { activo: false } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/compras/proveedores/[id]');
  }
}
