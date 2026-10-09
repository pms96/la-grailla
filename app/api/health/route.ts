export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { isSchemaAtLeast, ONBOARDING_REQUIRED_CONFIG } from '@grailla/contracts';
import { prisma } from '@/lib/prisma';
import { authorizeCron } from '@/lib/cron-auth';
import { getOnboardingStatus, onboardingApplies } from '@/lib/onboarding';
import { expectedSchema } from '@/lib/platform/expected-schema';
import { FRONT_MIN_SCHEMA } from '@/lib/platform/min-schema';
import { currentTenant } from '@/lib/tenant/context';
import { gateBySchema } from '@/lib/tenant/middleware';
import { isPlatformMode } from '@/lib/tenant/mode';

/* Salud del front para ESTE cliente.
 *  - Público y sin datos: `{status}` y 200 si la BD responde, 503 si no. Sirve a un monitor externo.
 *  - Con `Authorization: Bearer` válido (el mismo secreto de cron del cliente): el detalle que usa el panel para decidir si un cliente
 *    está al día (versión del front, esquema aplicado frente al que exige el build, onboarding).
 * Nunca devuelve URLs de BD, secretos ni trazas. */

const headers = { 'Cache-Control': 'no-store' };

async function appliedSchema(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name DESC LIMIT 1`;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

/** El id de cliente con que el panel marcó esta BD al darla de alta (AppConfig `platform_tenant_id`), o null si no tiene marca. */
async function databaseTenantMarker(): Promise<string | null> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: 'platform_tenant_id' }, select: { value: true } });
    return row?.value?.trim() || null;
  } catch {
    return null;
  }
}

async function isAuthorized(request: Request): Promise<boolean> {
  try {
    return (await authorizeCron(request)) === 'ok';
  } catch {
    return false; // sin contexto de cliente en modo plataforma: solo la respuesta pública
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const latencyMs = Date.now() - startedAt;

  // ¿Está el front sirviendo a este cliente? Si la puerta de esquema lo corta, desde fuera NO debe verse «ok»: un monitor externo
  // sobre esta ruta (la única que la puerta deja pasar) vería verde con el cliente entero en mantenimiento.
  const serving = !isPlatformMode() || gateBySchema('/', currentTenant()?.schemaVersion) === null;

  // ¿Es esta BD de este cliente? Si la marca dice otro, el aislamiento está roto por configuración (URLs cambiadas a la BD de otro cliente):
  // es un error también para un monitor externo (la respuesta pública no dice por qué).
  const tenantMarker = dbOk && isPlatformMode() ? await databaseTenantMarker() : null;
  const tenantId = isPlatformMode() ? (currentTenant()?.tenantId ?? null) : null;
  const wrongDatabase = !!tenantMarker && !!tenantId && tenantMarker !== tenantId;

  if (!(await isAuthorized(request))) {
    if (!dbOk || wrongDatabase) return NextResponse.json({ status: 'error' }, { status: 503, headers });
    return serving ? NextResponse.json({ status: 'ok' }, { headers }) : NextResponse.json({ status: 'maintenance' }, { status: 503, headers });
  }

  const applied = dbOk ? await appliedSchema() : null;
  const upToDate = isSchemaAtLeast(applied, FRONT_MIN_SCHEMA);
  // Sin BD no se puede saber: se informa todo como pendiente, nunca «completo».
  let onboarding: { complete: boolean; missing: string[] } = { complete: false, missing: [...ONBOARDING_REQUIRED_CONFIG] };
  if (dbOk) {
    try {
      onboarding = await getOnboardingStatus();
    } catch {
      /* se queda el valor por defecto */
    }
  }
  // El onboarding solo degrada a quien se le exige (cliente nuevo en modo plataforma); a La Grailla no.
  const onboardingPending = dbOk && onboardingApplies() && !onboarding.complete;
  const status = !dbOk || wrongDatabase ? 'error' : !serving || !upToDate || onboardingPending ? 'degraded' : 'ok';

  return NextResponse.json(
    {
      status,
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
      platform: isPlatformMode(),
      tenantId,
      tenantMarker,
      serving,
      db: { ok: dbOk, latencyMs },
      schema: { applied, expected: expectedSchema(), minRequired: FRONT_MIN_SCHEMA, upToDate },
      onboarding,
    },
    { status: dbOk && !wrongDatabase ? 200 : 503, headers }
  );
}
