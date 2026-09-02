export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const createProveedorSchema = z.object({
  nombre: z.string().min(1),
  contacto: z.string().optional().nullable(),
  telefono: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const proveedores = await prisma.proveedor.findMany({ orderBy: { nombre: 'asc' } });
    return NextResponse.json(proveedores ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/proveedores');
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = createProveedorSchema.parse(await request.json());
    const proveedor = await prisma.proveedor.create({
      data: {
        nombre: body.nombre,
        contacto: body.contacto || null,
        telefono: body.telefono || null,
        email: body.email || null,
        notas: body.notas || null,
      },
    });
    return NextResponse.json(proveedor);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/compras/proveedores');
  }
}
