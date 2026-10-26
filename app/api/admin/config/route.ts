export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { SECRET_MASK, encryptSecret, isSensitiveConfigKey, isWriteOnlyConfigKey } from '@/lib/secrets';
import { isConfigKeyAllowed, invalidConfigValue } from '@/lib/config-ownership';
import { getActiveModules } from '@/lib/modules/runtime';
import { SECTION_CONFIG_KEYS, SECTION_KINDS, sectionImageUrls } from '@/lib/content/sections';
import { releaseUnusedBlobs } from '@/lib/blob-cleanup';

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

/** ¿Es la clave de una sección de contenido (servicios, proyectos, equipo, FAQ)? */
const sectionKind = (key: string) => SECTION_KINDS.find((k) => SECTION_CONFIG_KEYS[k] === key);

export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    // Solo las claves de los módulos que el cliente tiene (ver lib/config-ownership.ts): sin Entradas no sale la comisión, sin Wallets no
    // salen sus certificados. Las claves internas y las desconocidas nunca salen.
    const active = getActiveModules();
    const all = await prisma.appConfig.findMany({ orderBy: [{ group: 'asc' }, { key: 'asc' }] });
    const configs = all.filter((c) => isConfigKeyAllowed(c.key, active, session.user.modules));
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
    const active = getActiveModules();

    // Solo se guardan claves de módulos activos (las internas, como el tema —que tiene su ruta—, y las desconocidas, nunca). Se avisa de
    // las ignoradas en lugar de fallar: la pantalla manda todo lo que cargó.
    const ignored: string[] = [];
    const accepted: { key: string; value: string; label?: string; group?: string }[] = [];
    for (const cfg of body.configs) {
      if (!cfg?.key) continue;
      if (!isConfigKeyAllowed(cfg.key, active, session.user.modules)) {
        ignored.push(cfg.key);
        continue;
      }
      // Copiar una API key desde el dashboard de la pasarela suele arrastrar un
      // espacio o salto de línea invisible — eso rompe el header Authorization
      // en silencio y la pasarela responde 401 sin ninguna pista de por qué.
      const trimmedValue = (cfg.value ?? '').trim();
      // La máscara que devuelve el GET significa "no se ha tocado": se conserva el valor guardado.
      if (isWriteOnlyConfigKey(cfg.key) && trimmedValue === SECRET_MASK) continue;
      accepted.push({ key: cfg.key, value: trimmedValue, label: cfg.label, group: cfg.group });
    }

    // Se valida TODO antes de escribir nada: un envío con un valor inválido no guarda ni la mitad.
    const errors = accepted
      .map((c) => ({ key: c.key, reason: invalidConfigValue(c.key, c.value) }))
      .filter((e): e is { key: string; reason: string } => e.reason !== null);
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.map((e) => `${e.key}: ${e.reason}`).join('; '), errors }, { status: 400 });
    }

    // Imágenes de las secciones de contenido antes de guardar: las que se sustituyan o se quiten ya no las usa nadie.
    const sectionsBefore = await prisma.appConfig.findMany({ where: { key: { in: accepted.map((c) => c.key).filter((k) => sectionKind(k)) } } });

    for (const cfg of accepted) {
      const value = isSensitiveConfigKey(cfg.key) ? encryptSecret(cfg.value, cfg.key) : cfg.value;
      await prisma.appConfig.upsert({
        where: { key: cfg.key },
        update: { value },
        create: { key: cfg.key, value, label: cfg.label ?? cfg.key, group: cfg.group ?? 'general' },
      });
    }

    const imagesBefore = sectionsBefore.flatMap((row) => sectionImageUrls(row.value, sectionKind(row.key)!));
    const imagesAfter = accepted.flatMap((c) => {
      const kind = sectionKind(c.key);
      return kind ? sectionImageUrls(c.value, kind) : [];
    });
    await releaseUnusedBlobs(imagesBefore, imagesAfter);
    return NextResponse.json({ success: true, ignored });
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/config');
  }
}
