export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { SECRET_MASK, encryptSecret, isSensitiveConfigKey, isWriteOnlyConfigKey } from '@/lib/secrets';

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
    // Las credenciales son de solo escritura: el navegador recibe una máscara,
    // nunca el valor (ni descifrado ni el blob cifrado). Así un guardado desde el
    // formulario sin tocar el campo no puede reescribir la credencial, y un
    // valor que no se pueda descifrar ya no se vuelve a guardar como vacío.
    const masked = (configs ?? []).map((c) =>
      isWriteOnlyConfigKey(c.key) && c.value ? { ...c, value: SECRET_MASK } : c
    );
    return NextResponse.json(masked);
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
        // Copiar una API key desde el dashboard de la pasarela suele arrastrar un
        // espacio o salto de línea invisible — eso rompe el header Authorization
        // en silencio y la pasarela responde 401 sin ninguna pista de por qué.
        const trimmedValue = (cfg.value ?? '').trim();
        // La máscara que devuelve el GET significa "no se ha tocado": se conserva
        // el valor guardado.
        if (isWriteOnlyConfigKey(cfg.key) && trimmedValue === SECRET_MASK) continue;
        const value = isSensitiveConfigKey(cfg.key) ? encryptSecret(trimmedValue) : trimmedValue;
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
