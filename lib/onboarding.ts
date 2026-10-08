import { missingOnboarding, ONBOARDING_REQUIRED_CONFIG, type OnboardingConfigKey } from '@grailla/contracts';
import { getConfigs } from '@/lib/config';
import { currentTenant, isLegacyTenant } from '@/lib/tenant/context';
import { isPlatformMode } from '@/lib/tenant/mode';

/* Onboarding (M7): los datos sin los que un cliente nuevo no debería publicar su web (destinatario de los avisos y los textos legales).
 * La lista y la regla de «qué falta» son del contrato (`@grailla/contracts`), las mismas que usa el panel. */

export type OnboardingStatus = { complete: boolean; missing: OnboardingConfigKey[] };

/** Lo que falta en la BD del cliente de la petición. El correo y los textos se leen con `getConfigs` (una sola consulta; el valor por defecto de un cliente nuevo es vacío). */
export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const values = await getConfigs([...ONBOARDING_REQUIRED_CONFIG]);
  const missing = missingOnboarding(values);
  return { complete: missing.length === 0, missing };
}

/**
 * ¿Se le exige el onboarding a ESTA petición? Solo en modo plataforma y a clientes que no son el legacy: La Grailla (y la instalación
 * única) ya está publicada con sus textos y no debe ver avisos ni salir «degradada» por esto.
 */
export function onboardingApplies(): boolean {
  if (!isPlatformMode()) return false;
  return currentTenant() !== null && !isLegacyTenant();
}

/** Cómo se nombra cada dato pendiente al administrador del cliente. */
export const ONBOARDING_LABELS: Record<OnboardingConfigKey, string> = {
  admin_email: 'correo de avisos',
  legal_notice: 'aviso legal',
  privacy_policy: 'política de privacidad',
  cookies_policy: 'política de cookies',
};

/** Texto del aviso del panel («Completa estos datos antes de publicar la web: …»). */
export function onboardingNoticeText(missing: readonly OnboardingConfigKey[]): string {
  return `Completa estos datos antes de publicar la web: ${missing.map((k) => ONBOARDING_LABELS[k]).join(', ')}.`;
}

/** Lo que debe mostrar el panel: los datos pendientes SOLO para quien se le exige el onboarding (si no, nada: ni consulta a la BD). */
export async function getOnboardingNotice(): Promise<OnboardingConfigKey[]> {
  if (!onboardingApplies()) return [];
  return (await getOnboardingStatus()).missing;
}
