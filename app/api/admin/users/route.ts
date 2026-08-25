export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import bcrypt from 'bcryptjs';
import { handleApiError } from '@/lib/api-error';

const createUserSchema = z.object({
  email: z.string().min(1, 'email_is_required').email('invalid_email'),
  password: z.string().min(8, 'password_too_short'),
  name: z.string().optional(),
  role: z.enum(['ADMIN', 'TAQUILLA', 'USER']).optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, createdAt: true },
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
  try {
    const { email, password, name, role } = createUserSchema.parse(await request.json());
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: 'El email ya está registrado' }, { status: 409 });
    }
    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, name: name ?? '', hashedPassword: hashed, role: role ?? 'USER' },
    });
    return NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/users');
  }
}
