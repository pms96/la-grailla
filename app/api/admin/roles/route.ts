export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { isOwnerAdmin } from '@/lib/access-roles';
import { PRESET_ROLES, validateCustomRole } from '@/lib/modules/access';
import { actorFromSession, recordAdminAuditSafe } from '@/lib/admin-audit';

const roleSchema = z.object({ name: z.string(), modules: z.array(z.string()) });

/** Solo el propietario (administrador sin restricción de módulos) gestiona roles. */
async function requireOwner() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!isOwnerAdmin(session)) return NextResponse.json({ error: 'Solo el propietario puede gestionar roles' }, { status: 403 });
  return null;
}

/** Los roles predefinidos (en código) y los personalizados del cliente (alias + módulos). */
export async function GET() {
  const denied = await requireOwner();
  if (denied) return denied;
  try {
    const custom = await prisma.accessRole.findMany({ orderBy: { name: 'asc' } });
    const presets = Object.entries(PRESET_ROLES).map(([key, r]) => ({ key, label: r.label, description: r.description, modules: r.modules }));
    return NextResponse.json({ presets, custom: custom.map((r) => ({ id: r.id, name: r.name, modules: r.modules })) });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/roles');
  }
}

export async function POST(request: Request) {
  const denied = await requireOwner();
  if (denied) return denied;
  try {
    const body = roleSchema.parse(await request.json());
    const problem = validateCustomRole(body);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const name = body.name.trim();
    if (await prisma.accessRole.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } })) {
      return NextResponse.json({ error: 'Ya existe un rol con ese nombre' }, { status: 409 });
    }
    const role = await prisma.accessRole.create({ data: { name, modules: body.modules } });
    await recordAdminAuditSafe(actorFromSession(await getServerSession(authOptions)), request, {
      action: 'role.create',
      targetType: 'AccessRole',
      targetId: role.id,
      meta: { name: role.name, modules: role.modules },
    });
    return NextResponse.json({ id: role.id, name: role.name, modules: role.modules }, { status: 201 });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/roles');
  }
}
