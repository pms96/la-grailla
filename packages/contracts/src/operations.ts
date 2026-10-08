/* Contratos de operación (M7) que comparten el panel y el front.
 *
 *  - Secreto de cron por cliente: el disparador del panel llama a /api/cron/* de CADA cliente con un secreto distinto, derivado de un
 *    maestro y del tenantId. Un secreto filtrado de un cliente no abre los crons de otro, y el front no necesita una lista de secretos.
 *  - Versión de esquema: los nombres de migración de Prisma empiezan por una marca de tiempo (YYYYMMDDHHMMSS_nombre) y por eso se
 *    pueden ordenar sin ambigüedad.
 *  - Datos mínimos obligatorios para publicar a un cliente nuevo. */
import { toBase64Url } from './snapshot';

const enc = new TextEncoder();

/** Dominio de separación: este HMAC no se puede confundir con ningún otro uso del mismo maestro. */
export const CRON_SECRET_LABEL = 'grailla-cron-secret:v1';

export async function deriveCronSecret(master: Uint8Array, tenantId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', master, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${CRON_SECRET_LABEL}|${tenantId}`));
  return toBase64Url(new Uint8Array(mac));
}

const MIGRATION_NAME_RE = /^(\d{14})_[A-Za-z0-9_]+$/;

/** Marca de tiempo (14 dígitos) de un nombre de migración, o null si no tiene el formato de Prisma. */
export function migrationStamp(name: string | null | undefined): string | null {
  const m = MIGRATION_NAME_RE.exec(name ?? '');
  return m ? m[1] : null;
}

/**
 * ¿La BD está al menos en `min`? Un valor ilegible NUNCA cuenta como «al día»: ante la duda, no (el front muestra mantenimiento
 * solo a ese cliente en lugar de arriesgarse a un 500 en cada lectura).
 */
export function isSchemaAtLeast(actual: string | null | undefined, min: string | null | undefined): boolean {
  const a = migrationStamp(actual);
  const m = migrationStamp(min);
  if (m === null) return true; // sin exigencia (o exigencia ilegible): no se corta a nadie por esto
  if (a === null) return false;
  return a >= m;
}

/** Configuración sin la que un cliente nuevo no puede publicarse: destinatario de los avisos y los tres textos legales. */
export const ONBOARDING_REQUIRED_CONFIG = ['admin_email', 'legal_notice', 'privacy_policy', 'cookies_policy'] as const;
export type OnboardingConfigKey = (typeof ONBOARDING_REQUIRED_CONFIG)[number];

/** Qué falta (vacío = listo). Un texto de solo espacios no cuenta; el correo debe parecer un correo. */
export function missingOnboarding(values: Partial<Record<string, string | null | undefined>>): OnboardingConfigKey[] {
  return ONBOARDING_REQUIRED_CONFIG.filter((key) => {
    const v = (values[key] ?? '').trim();
    if (!v) return true;
    return key === 'admin_email' ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) : false;
  });
}
