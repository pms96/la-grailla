export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { isOwnerAdmin } from '@/lib/access-roles';
import { CUSTOM_ROLE_PREFIX, validateCustomRole } from '@/lib/modules/access';

const roleSchema = z.object({ name: z.string(), modules: z.array(z.string()) });

async function requireOwner() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!isOwnerAdmin(session)) return NextResponse.json({ error: 'Solo el propietario puede gestionar roles' }, { status: 403 });
  return null;
}

/** Editar un rol: las sesiones de quienes lo tienen se cierran solas (su sesión lleva la clave de los permisos antiguos). */
export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const denied = await requireOwner();
  if (denied) return denied;
  try {
    const body = roleSchema.parse(await request.json());
    const problem = validateCustomRole(body);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const current = await prisma.accessRole.findUnique({ where: { id: params?.id }, select: { id: true } });
    if (!current) return NextResponse.json({ error: 'Rol no encontrado' }, { status: 404 });
    const name = body.name.trim();
    const clash = await prisma.accessRole.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, NOT: { id: params.id } }, select: { id: true } });
    if (clash) return NextResponse.json({ error: 'Ya existe un rol con ese nombre' }, { status: 409 });
    const role = await prisma.accessRole.update({ where: { id: params.id }, data: { name, modules: body.modules } });
    return NextResponse.json({ id: role.id, name: role.name, modules: role.modules });
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/roles/[id]');
  }
}

/** Borrar un rol: se niega si alguien lo tiene (habría que dejarlo sin permisos de golpe). */
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const denied = await requireOwner();
  if (denied) return denied;
  try {
    const current = await prisma.accessRole.findUnique({ where: { id: params?.id }, select: { id: true } });
    if (!current) return NextResponse.json({ error: 'Rol no encontrado' }, { status: 404 });
    const inUse = await prisma.user.count({ where: { accessRole: `${CUSTOM_ROLE_PREFIX}${params.id}` } });
    if (inUse > 0) {
      return NextResponse.json({ error: `Este rol lo tienen ${inUse} usuario${inUse === 1 ? '' : 's'}: cámbiales el rol antes de borrarlo` }, { status: 409 });
    }
    await prisma.accessRole.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/roles/[id]');
  }
}
