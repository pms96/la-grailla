import { deriveCronSecret, parseMasterKey } from '@grailla/contracts';
import { timingSafeEqualString } from '@/lib/secrets';
import { requireTenant } from '@/lib/tenant/context';
import { isLegacyTenant } from '@/lib/tenant/installation-secret';
import { isPlatformMode } from '@/lib/tenant/mode';

/* Autenticación de /api/cron/* y del detalle de /api/health (M7).
 *
 *  - Modo normal: `Authorization: Bearer ${CRON_SECRET}`, como siempre.
 *  - Modo plataforma: el secreto válido es el DERIVADO de PLATFORM_CRON_MASTER y del tenantId de ESTA petición. El disparador del panel
 *    llama a cada cliente con su propio secreto: el de A se rechaza en B, y el front no guarda una lista de secretos. El cliente legacy
 *    acepta además el CRON_SECRET global para que los workflows de GitHub de La Grailla sigan valiendo durante la observación.
 *    Ningún otro cliente acepta nunca el CRON_SECRET global. */

export type CronAuthResult = 'ok' | 'unauthorized' | 'not_configured';

/** Secretos que abren los crons de esta petición. Vacío = no hay ninguno configurado. */
async function validSecrets(): Promise<string[]> {
  if (!isPlatformMode()) {
    const secret = process.env.CRON_SECRET;
    return secret ? [secret] : [];
  }
  const ctx = requireTenant();
  const secrets: string[] = [];
  const rawMaster = process.env.PLATFORM_CRON_MASTER;
  if (rawMaster) {
    try {
      secrets.push(await deriveCronSecret(parseMasterKey(rawMaster), ctx.tenantId));
    } catch {
      // Un maestro ilegible equivale a no tenerlo (sin imprimir su valor).
      console.error('[cron-auth] PLATFORM_CRON_MASTER no es una clave de 32 bytes válida');
    }
  }
  if (isLegacyTenant(ctx) && process.env.CRON_SECRET) secrets.push(process.env.CRON_SECRET);
  return secrets;
}

export async function authorizeCron(request: Request): Promise<CronAuthResult> {
  const secrets = await validSecrets();
  if (secrets.length === 0) return 'not_configured';
  const given = request.headers.get('authorization') ?? '';
  // Se comparan todos (sin cortar en el primero) para no distinguir por tiempo cuál de ellos acertó.
  let ok = false;
  for (const secret of secrets) ok = timingSafeEqualString(given, `Bearer ${secret}`) || ok;
  return ok ? 'ok' : 'unauthorized';
}
