export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { SHOP_ACCOUNT_SINCE_KEY, hasConfigRow } from '@/lib/config';
import { SECRET_MASK, encryptSecret, isSensitiveConfigKey, isWriteOnlyConfigKey } from '@/lib/secrets';
import { isConfigKeyAllowed, invalidConfigValue } from '@/lib/config-ownership';
import { getActiveModules, isModuleEnabled } from '@/lib/modules/runtime';
import { SECTION_CONFIG_KEYS, SECTION_KINDS, sectionImageUrls } from '@/lib/content/sections';
import { releaseUnusedBlobs } from '@/lib/blob-cleanup';
import { actorFromSession, recordAdminAuditSafe } from '@/lib/admin-audit';

/** Claves cuyo valor NO es secreto y sí interesa ver en el registro de auditoría (de → a): pasarela, SMTP no sensible, comisión, IVA y corte de caja. */
const AUDIT_VISIBLE_VALUE_KEYS = [
  'payment_gateway', 'shop_payment_gateway', 'smtp_enabled', 'smtp_host', 'smtp_port', 'smtp_secure',
  'commission_percentage', 'vat_rate_entradas', 'vat_rate_tienda', 'jornada_corte_hora',
];

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

    // P1-11: la PRIMERA vez que la Tienda guarda su propia pasarela deja de heredar la cuenta de Entradas. Se anota cuándo, para que los pedidos
    // cobrados antes sigan verificándose y reembolsándose con la cuenta con la que se cobraron (`accountScopeForOrder`). Solo la primera vez.
    // Solo si el módulo Entradas existe: sin él la tienda ya usaba sus propias claves y no había cuenta que heredar. Y en la MISMA transacción que el guardado:
    // si éste falla a medias, la fecha no queda puesta sin que exista la fila de la pasarela (revisión de P1-11).
    const markAccountChange =
      isModuleEnabled('entradas') && accepted.some((c) => c.key === 'shop_payment_gateway') && !(await hasConfigRow('shop_payment_gateway'));
    // Qué cambia de verdad (OB-12). La pantalla reenvía todo lo que cargó: se compara con lo guardado para no anotar lo que sigue igual. Una clave
    // sensible que llega aquí (no es la máscara) es una escritura; su valor no se compara ni se registra, solo su nombre.
    const storedRows = await prisma.appConfig.findMany({ where: { key: { in: accepted.map((c) => c.key) } }, select: { key: true, value: true } });
    const stored = new Map(storedRows.map((r) => [r.key, r.value]));
    const changedKeys = accepted.filter((c) => isSensitiveConfigKey(c.key) || (stored.get(c.key) ?? null) !== c.value).map((c) => c.key);
    const prepared = accepted.map((cfg) => ({ cfg, value: isSensitiveConfigKey(cfg.key) ? encryptSecret(cfg.value, cfg.key) : cfg.value }));
    await prisma.$transaction(async (tx) => {
      if (markAccountChange) {
        await tx.appConfig.upsert({
          where: { key: SHOP_ACCOUNT_SINCE_KEY },
          update: {},
          create: { key: SHOP_ACCOUNT_SINCE_KEY, value: String(Date.now()), label: SHOP_ACCOUNT_SINCE_KEY, group: 'system' },
        });
      }
      for (const { cfg, value } of prepared) {
        await tx.appConfig.upsert({
          where: { key: cfg.key },
          update: { value },
          create: { key: cfg.key, value, label: cfg.label ?? cfg.key, group: cfg.group ?? 'general' },
        });
      }
    });

    if (changedKeys.length > 0) {
      const valores: Record<string, { from: string | null; to: string }> = {};
      for (const c of accepted) {
        if (changedKeys.includes(c.key) && AUDIT_VISIBLE_VALUE_KEYS.includes(c.key)) valores[c.key] = { from: stored.get(c.key) ?? null, to: c.value };
      }
      await recordAdminAuditSafe(actorFromSession(session), request, {
        action: 'config.update',
        targetType: 'AppConfig',
        meta: { claves: changedKeys, sensibles: changedKeys.filter((k) => isSensitiveConfigKey(k)), valores },
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
