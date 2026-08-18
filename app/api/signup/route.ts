export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { handleApiError } from '@/lib/api-error';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

const signupSchema = z.object({
  email: z.string().min(1, 'email_is_required').email('invalid_email'),
  password: z.string().min(1, 'password_is_required'),
  name: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const limit = rateLimit('signup', getClientIp(request), 5, 15 * 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Has realizado demasiados intentos. Espera un momento antes de volver a intentarlo.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
      );
    }

    const { email, password, name } = signupSchema.parse(await request.json());

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: 'Ya existe una cuenta con este email' }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        email,
        name: name ?? '',
        hashedPassword,
        role: 'USER',
      },
    });

    return NextResponse.json({ success: true, userId: user.id });
  } catch (error) {
    return handleApiError(error, 'POST /api/signup');
  }
}
