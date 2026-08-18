export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { decryptSecret, encryptSecret, isSensitiveConfigKey } from '@/lib/secrets';

const updateConfigSchema = z.object({
  configs: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.string().optional(),
        label: z.string().optional(),
        group: z.string().optional(),
      })
    )
    .default([]),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const configs = await prisma.appConfig.findMany({ orderBy: { group: 'asc' } });
    // El admin necesita ver/editar el valor real en el formulario, no el
    // blob cifrado que hay en la base de datos.
    const decrypted = (configs ?? []).map((c) =>
      isSensitiveConfigKey(c.key) ? { ...c, value: decryptSecret(c.value) } : c
    );
    return NextResponse.json(decrypted);
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/config');
  }
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateConfigSchema.parse(await request.json());
    const updates = body.configs;
    for (const cfg of updates) {
      if (cfg?.key) {
        const value = isSensitiveConfigKey(cfg.key) ? encryptSecret(cfg.value ?? '') : (cfg.value ?? '');
        await prisma.appConfig.upsert({
          where: { key: cfg.key },
          update: { value },
          create: { key: cfg.key, value, label: cfg.label ?? cfg.key, group: cfg.group ?? 'general' },
        });
      }
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/config');
  }
}
