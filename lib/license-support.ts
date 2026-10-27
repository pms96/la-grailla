/* A quién se paga y a quién se escribe cuando la licencia de un cliente vence. El contrato del registro (RoutingRecord) no lleva datos de
 * contacto, así que el del proveedor de la plataforma se configura por despliegue, sin migración ni cambio de contrato:
 *   - PLATFORM_SUPPORT_EMAIL: dirección de soporte/facturación (opcional).
 *   - PLATFORM_SUPPORT_URL: enlace https a una página de soporte o de pago (opcional).
 * Son datos públicos (se muestran en pantalla), nunca secretos. Con alguno mal escrito se ignora ese; sin ninguno, los avisos remiten al
 * «proveedor de la plataforma» sin inventar nada. */

export type ProviderContact = { email: string | null; url: string | null };

// Deliberadamente sencilla: una dirección rota solo desactiva el enlace, nunca rompe la pantalla del aviso.
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function providerContact(env: Record<string, string | undefined> = process.env): ProviderContact {
  const rawEmail = (env.PLATFORM_SUPPORT_EMAIL ?? '').trim();
  const rawUrl = (env.PLATFORM_SUPPORT_URL ?? '').trim();
  let url: string | null = null;
  try {
    const parsed = rawUrl ? new URL(rawUrl) : null;
    // Solo https y sin credenciales incrustadas: es un enlace que el cliente pulsará con el panel bloqueado.
    if (parsed && parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.toString();
  } catch {
    url = null;
  }
  return { email: EMAIL.test(rawEmail) ? rawEmail : null, url };
}
