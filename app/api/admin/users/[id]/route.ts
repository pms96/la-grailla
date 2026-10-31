export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { isModuleEnabled } from '@/lib/modules/runtime';
import { accessRoleProblem, countOwners, isOwnerAdmin } from '@/lib/access-roles';
import { actorFromSession, recordAdminAuditSafe } from '@/lib/admin-audit';

const updateUserSchema = z.object({
  role: z.enum(['ADMIN', 'TAQUILLA', 'USER']).optional(),
  name: z.string().optional().nullable(),
  password: z.string().min(8, 'password_too_short').optional(),
  // Rol por módulos (ver lib/modules/access.ts): clave predefinida, `c_<id>`, o null = propietario.
  accessRole: z.string().nullable().optional(),
});

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  // Gestionar usuarios es solo del propietario: un rol restringido podría darse más permisos.
  if (!isOwnerAdmin(session)) {
    return NextResponse.json({ error: 'Solo el propietario puede gestionar usuarios' }, { status: 403 });
  }
  try {
    const body = updateUserSchema.parse(await request.json());
    // Asignar TAQUILLA exige el módulo Entradas; dejarlo como está (editar el nombre o la contraseña de quien ya lo es) no.
    if (body?.role === 'TAQUILLA' && !isModuleEnabled('entradas')) {
      const current = await prisma.user.findUnique({ where: { id: params?.id }, select: { role: true } });
      if (current?.role !== 'TAQUILLA') {
        return NextResponse.json({ error: 'El rol de taquilla requiere el módulo de venta de entradas' }, { status: 400 });
      }
    }

    // Sin este guard, un admin podría quitarse a sí mismo el rol ADMIN (o
    // borrarse, en el DELETE de abajo) y quedarse fuera del panel sin nadie
    // que pueda revertirlo salvo tocando la base de datos a mano.
    if (body?.role && body.role !== 'ADMIN' && params?.id === session.user?.id) {
      return NextResponse.json({ error: 'No puedes quitarte a ti mismo el rol de administrador' }, { status: 400 });
    }
    const target = await prisma.user.findUnique({ where: { id: params?.id }, select: { role: true, accessRole: true } });
    const targetIsOwner = target?.role === 'ADMIN' && target.accessRole === null;
    if (body?.role && body.role !== 'ADMIN') {
      if (target?.role === 'ADMIN') {
        const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
        if (adminCount <= 1) {
          return NextResponse.json({ error: 'No puedes quitar el último administrador' }, { status: 400 });
        }
        if (targetIsOwner && (await countOwners()) <= 1) {
          return NextResponse.json({ error: 'No puedes quitar al último propietario' }, { status: 400 });
        }
      }
    }

    // Rol por módulos. Quien deja de ser administrador no conserva uno. Un rol restringido se asigna solo a administradores que existan.
    let accessRole: string | null | undefined = body?.accessRole;
    if (body?.role && body.role !== 'ADMIN') accessRole = null;
    const accessRoleChanges = accessRole !== undefined && accessRole !== (target?.accessRole ?? null);
    if (accessRole !== undefined) {
      const problem = await accessRoleProblem(accessRole, body?.role ?? target?.role ?? 'USER');
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      if (accessRoleChanges && params?.id === session.user?.id) {
        return NextResponse.json({ error: 'No puedes cambiarte tu propio rol de acceso' }, { status: 400 });
      }
      if (accessRoleChanges && targetIsOwner && accessRole !== null && (await countOwners()) <= 1) {
        return NextResponse.json({ error: 'No puedes restringir al último propietario: el cliente se quedaría sin nadie que gestione usuarios' }, { status: 400 });
      }
    }

    // Cambiar la contraseña, el rol de cuenta o el rol por módulos cierra las sesiones que esa persona tenga abiertas.
    const revokeSessions = Boolean(body?.password) || accessRoleChanges || Boolean(body?.role && body.role !== target?.role);

    const user = await prisma.user.update({
      where: { id: params?.id },
      data: {
        role: body?.role,
        name: body?.name,
        ...(accessRole !== undefined ? { accessRole } : {}),
        ...(body?.password ? { hashedPassword: await bcrypt.hash(body.password, 12) } : {}),
        ...(revokeSessions ? { sessionsValidAfter: new Date() } : {}),
      },
      select: { id: true, name: true, email: true, role: true, accessRole: true },
    });
    // Nunca la contraseña: solo que se cambió. Rol de cuenta y rol por módulos, de → a.
    await recordAdminAuditSafe(actorFromSession(session), request, {
      action: 'user.update',
      targetType: 'User',
      targetId: user.id,
      meta: {
        email: user.email,
        // Sin la palabra «password» en la clave: el saneado del registro tapa cualquier clave con ese nombre y perdería el dato.
        contrasenaCambiada: Boolean(body?.password),
        role: { from: target?.role ?? null, to: user.role },
        accessRole: { from: target?.accessRole ?? null, to: user.accessRole },
        sessionsRevoked: revokeSessions,
      },
    });
    return NextResponse.json(user);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/users/[id]');
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  if (!isOwnerAdmin(session)) {
    return NextResponse.json({ error: 'Solo el propietario puede gestionar usuarios' }, { status: 403 });
  }
  try {
    if (params?.id === session.user?.id) {
      return NextResponse.json({ error: 'No puedes eliminar tu propia cuenta' }, { status: 400 });
    }
    const target = await prisma.user.findUnique({ where: { id: params?.id }, select: { role: true, accessRole: true, email: true } });
    if (target?.role === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        return NextResponse.json({ error: 'No puedes eliminar el último administrador' }, { status: 400 });
      }
      if (target.accessRole === null && (await countOwners()) <= 1) {
        return NextResponse.json({ error: 'No puedes eliminar al último propietario' }, { status: 400 });
      }
    }
    // Al borrarlo, su sesión deja de valer al instante: cada lectura de sesión contrasta con la BD (lib/auth.ts).
    await prisma.user.delete({ where: { id: params?.id } });
    await recordAdminAuditSafe(actorFromSession(session), request, {
      action: 'user.delete',
      targetType: 'User',
      targetId: params?.id,
      meta: { email: target?.email ?? null, role: target?.role ?? null, accessRole: target?.accessRole ?? null },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/users/[id]');
  }
}
