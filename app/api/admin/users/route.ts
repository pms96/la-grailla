export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import bcrypt from 'bcryptjs';
import { handleApiError } from '@/lib/api-error';
import { isModuleEnabled } from '@/lib/modules/runtime';
import { accessRoleProblem, isOwnerAdmin } from '@/lib/access-roles';
import { actorFromSession, recordAdminAuditSafe } from '@/lib/admin-audit';

const createUserSchema = z.object({
  email: z.string().min(1, 'email_is_required').email('invalid_email'),
  password: z.string().min(8, 'password_too_short'),
  name: z.string().optional(),
  role: z.enum(['ADMIN', 'TAQUILLA', 'USER']).optional(),
  // Rol por módulos: una clave predefinida o `c_<id>` de un rol personalizado. Sin él, propietario (como siempre).
  accessRole: z.string().nullable().optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  // Gestionar usuarios es solo del propietario: un rol restringido podría darse más permisos.
  if (!isOwnerAdmin(session)) {
    return NextResponse.json({ error: 'Solo el propietario puede gestionar usuarios' }, { status: 403 });
  }
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, accessRole: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(users ?? []);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/users');
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  if (!isOwnerAdmin(session)) {
    return NextResponse.json({ error: 'Solo el propietario puede gestionar usuarios' }, { status: 403 });
  }
  try {
    const { email, password, name, role, accessRole } = createUserSchema.parse(await request.json());
    const roleProblem = await accessRoleProblem(accessRole, role ?? 'USER');
    if (roleProblem) return NextResponse.json({ error: roleProblem }, { status: 400 });
    // TAQUILLA (venta en puerta) es un rol del módulo Entradas: sin él, los usuarios del panel tienen un solo rol.
    if (role === 'TAQUILLA' && !isModuleEnabled('entradas')) {
      return NextResponse.json({ error: 'El rol de taquilla requiere el módulo de venta de entradas' }, { status: 400 });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: 'El email ya está registrado' }, { status: 409 });
    }
    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, name: name ?? '', hashedPassword: hashed, role: role ?? 'USER', accessRole: accessRole ?? null },
    });
    await recordAdminAuditSafe(actorFromSession(session), request, {
      action: 'user.create',
      targetType: 'User',
      targetId: user.id,
      meta: { email: user.email, role: user.role, accessRole: user.accessRole },
    });
    return NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role, accessRole: user.accessRole });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/users');
  }
}
