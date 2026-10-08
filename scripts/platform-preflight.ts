/* Comprobación previa al corte (o al alta de un cliente) en el proyecto `platform`: usa EXACTAMENTE el código que servirá las
 * peticiones (resolutor, secretos, cliente Prisma por tenant) y falla si algo no está listo. No escribe nada.
 *
 *   PLATFORM_MODE=on (y el resto de variables del proyecto) \
 *   npx tsx scripts/platform-preflight.ts --host www.lagrailla.es [--legacy] [--expect-modules tienda,entradas]
 *
 * No imprime secretos: solo identificadores, estados y recuentos. Sale con código 1 si falla alguna comprobación. */
import { isSchemaAtLeast, parseMasterKey } from '@grailla/contracts';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';
import { runWithTenant } from '@/lib/tenant/context';
import { getRegistryReader, resolveHost } from '@/lib/tenant/resolve';
import { effectiveLicensePhase } from '@grailla/contracts';
import { isLegacyTenant } from '@/lib/tenant/installation-secret';

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function keyOk(name: string): boolean {
  try {
    parseMasterKey(process.env[name] ?? '');
    return true;
  } catch {
    return false;
  }
}

function jsonObject(name: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(process.env[name] ?? '');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Foto de las variables ANTES de cargar Prisma: al importarse, el cliente de Prisma lee un `.env` local y rellena DATABASE_URL, lo que
// daría un falso «definida» en un checkout de desarrollo (en Vercel no hay `.env`).
const initialEnv = { ...process.env };

async function main() {
  const host = arg('host');
  if (!host) throw new Error('Falta --host <dominio>');
  const { prisma } = await import('@/lib/prisma');
  const { decryptSecret } = await import('@/lib/secrets');

  // 1. El proyecto está en modo plataforma y sin variables globales de un solo cliente.
  add('PLATFORM_MODE=on', process.env.PLATFORM_MODE === 'on');
  for (const forbidden of ['DATABASE_URL', 'DIRECT_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL']) {
    add(`${forbidden} NO definida`, !initialEnv[forbidden], initialEnv[forbidden] ? 'bórrala del proyecto: en modo plataforma no existe un valor global' : undefined);
  }

  // 2. Claves y configuración.
  add('PLATFORM_CONTEXT_KEY válida (32 bytes)', keyOk('PLATFORM_CONTEXT_KEY'));
  add('PLATFORM_SESSION_MASTER válida (32 bytes)', keyOk('PLATFORM_SESSION_MASTER'));
  add('PLATFORM_CRON_MASTER válida (32 bytes; de ella salen los secretos de cron por cliente)', keyOk('PLATFORM_CRON_MASTER'));
  const secretKeys = jsonObject('SECRETS_KEYS');
  const activeKid = process.env.SECRETS_ACTIVE_KID ?? '';
  add('SECRETS_KEYS + SECRETS_ACTIVE_KID', !!secretKeys && activeKid in secretKeys && Object.values(secretKeys).every((v) => typeof v === 'string'));
  const pubKeys = jsonObject('SNAPSHOT_PUBKEYS');
  add('SNAPSHOT_PUBKEYS con al menos una clave', !!pubKeys && Object.keys(pubKeys).length > 0);
  add('Registro configurado (UPSTASH_REDIS_REST_*)', !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN);
  add('CRON_SECRET definida (los crons de GitHub la usan)', !!process.env.CRON_SECRET);
  add('BLOB_READ_WRITE_TOKEN definida (subidas de imágenes y vídeos)', !!process.env.BLOB_READ_WRITE_TOKEN);
  if (flag('legacy')) {
    add('LEGACY_TENANT_ID + LEGACY_NEXTAUTH_SECRET', !!process.env.LEGACY_TENANT_ID && !!process.env.LEGACY_NEXTAUTH_SECRET);
  }

  // 3. El Host resuelve con el código real, con lectura fresca y firmas válidas.
  let ctx: Awaited<ReturnType<typeof resolveHost>> | null = null;
  try {
    getRegistryReader();
    ctx = await resolveHost(host);
  } catch (err) {
    add('El registro responde', false, err instanceof Error ? err.message : String(err));
  }
  if (ctx) {
    add(`${host} resuelve a un cliente`, ctx.status === 'ok', ctx.status === 'ok' ? undefined : ctx.status === 'not_found' ? 'no está en el registro (¿dominio verificado y publicado?)' : ctx.reason);
  }
  if (ctx?.status !== 'ok') return report();
  const resolved = ctx.ctx;
  add('Lectura fresca (no servida desde caché obsoleta)', !ctx.stale);
  add('Cliente ACTIVE', resolved.status === 'ACTIVE', `estado ${resolved.status}`);
  const phase = resolved.license ? effectiveLicensePhase(resolved.license, Date.now(), { fresh: !ctx.stale }) : 'ACTIVE';
  add('Licencia al día (ACTIVE o GRACE)', phase === 'ACTIVE' || phase === 'GRACE', `fase ${phase}`);
  console.log(`  cliente ${resolved.tenantId} · producto ${resolved.product} · dominio principal ${resolved.primaryDomain} · módulos ${resolved.modules.join(',') || '(solo núcleo)'}`);
  const expected = arg('expect-modules')?.split(',').map((m) => m.trim()).filter(Boolean) ?? [];
  if (expected.length) {
    const missing = expected.filter((m) => !resolved.modules.includes(m));
    add('Módulos esperados activos', missing.length === 0, missing.length ? `faltan: ${missing.join(', ')}` : undefined);
  }
  // Puerta de esquema (M7): el registro del cliente debe declarar al menos la migración que exige este build; si no, el front lo pondría en mantenimiento.
  add(
    `Esquema del registro >= ${FRONT_MIN_SCHEMA}`,
    isSchemaAtLeast(resolved.schemaVersion, FRONT_MIN_SCHEMA),
    `registro: ${resolved.schemaVersion ?? 'desconocido'} — ejecuta el runner de migraciones antes de desplegar`
  );
  if (flag('legacy')) add('El host es el cliente legacy', isLegacyTenant(resolved), 'LEGACY_TENANT_ID no coincide con el cliente resuelto');

  // 4. La BD del cliente se abre (URL sellada → clave maestra del servidor) y tiene el esquema esperado.
  await runWithTenant({ ...resolved, host }, async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      add('Conexión a la BD del cliente (URL abierta con SECRETS_KEYS)', true);
    } catch (err) {
      add('Conexión a la BD del cliente (URL abierta con SECRETS_KEYS)', false, err instanceof Error ? err.message.slice(0, 160) : String(err));
      return;
    }
    try {
      const rows = await prisma.$queryRaw<{ last: string | null; n: bigint }[]>`
        SELECT (SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1) AS last,
               (SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS n`;
      add('Migraciones aplicadas', Number(rows[0]?.n ?? 0) > 0, `${Number(rows[0]?.n ?? 0)} aplicadas, última ${rows[0]?.last ?? '—'}`);
      add(
        `La BD del cliente tiene al menos ${FRONT_MIN_SCHEMA}`,
        isSchemaAtLeast(rows[0]?.last, FRONT_MIN_SCHEMA),
        `aplicada: ${rows[0]?.last ?? 'ninguna'} — ejecuta el runner de migraciones antes de desplegar`
      );
    } catch (err) {
      add('Migraciones aplicadas', false, err instanceof Error ? err.message.slice(0, 160) : String(err));
    }
    // Las credenciales guardadas se pueden descifrar (enc:v1 del cliente legacy, enc:v2 del resto).
    try {
      const sealed = await prisma.appConfig.findMany({ where: { OR: [{ value: { startsWith: 'enc:v1:' } }, { value: { startsWith: 'enc:v2:' } }] }, take: 20 });
      let failed = 0;
      for (const row of sealed) {
        try {
          decryptSecret(row.value, { configKey: row.key });
        } catch {
          failed++;
        }
      }
      add('Credenciales cifradas legibles', failed === 0, `${sealed.length - failed}/${sealed.length} abiertas`);
    } catch (err) {
      add('Credenciales cifradas legibles', false, err instanceof Error ? err.message.slice(0, 160) : String(err));
    }
  });
  return report();
}

function report(): void {
  console.log('');
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? 'Todo listo.' : `${failed.length} comprobación(es) fallida(s): NO hacer el corte.`}`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { disconnectAllTenantClients } = await import('@/lib/tenant/db');
    await disconnectAllTenantClients().catch(() => {});
  });
