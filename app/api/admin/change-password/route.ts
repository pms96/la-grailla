export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = changePasswordSchema.parse(await request.json());
    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (!user?.hashedPassword) {
      return NextResponse.json({ error: 'Esta cuenta no tiene contraseña configurada' }, { status: 400 });
    }
    const isValid = await bcrypt.compare(body.currentPassword, user.hashedPassword);
    if (!isValid) {
      return NextResponse.json({ error: 'Contraseña actual incorrecta' }, { status: 400 });
    }
    const hashedPassword = await bcrypt.hash(body.newPassword, 12);
    // Cambiar la contraseña cierra TODAS las sesiones abiertas de esta cuenta (también las de quien la hubiera robado), incluida la
    // actual: `signOut` le dice a la pantalla que vuelva a la de entrada.
    await prisma.user.update({ where: { id: user.id }, data: { hashedPassword, sessionsValidAfter: new Date() } });
    return NextResponse.json({ success: true, signOut: true });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/change-password');
  }
}
