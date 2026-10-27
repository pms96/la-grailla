import { prisma } from '@/lib/prisma';
import { SecretDecryptionError, decryptSecret, encryptSecret, isSensitiveConfigKey, shouldDecryptOnRead } from '@/lib/secrets';
import { DEFAULT_SPONSOR_TIERS } from '@/lib/sponsor-tiers';
import { isLegacyTenant } from '@/lib/tenant/context';
import { isPlatformMode } from '@/lib/tenant/mode';

const CONFIG_DEFAULTS: Record<string, string> = {
  payment_gateway: 'mock',
  sponsor_tiers: JSON.stringify(DEFAULT_SPONSOR_TIERS),
  sponsor_payment_pending_message:
    'Antes de poder ver tu vídeo final necesitamos confirmar el pago de tu patrocinio. Contacta con nosotros para completarlo.',
  stripe_publishable_key: '',
  stripe_secret_key: '',
  stripe_webhook_secret: '',
  sumup_api_key: '',
  sumup_merchant_code: '',
  commission_percentage: '0',
  legal_notice: '',
  privacy_policy: '',
  cookies_policy: '',
  social_instagram: '',
  social_tiktok: '',
  social_twitter: '',
  social_facebook: '',
  admin_email: 'grupolagrailla@gmail.com',
  smtp_enabled: 'false',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_password: '',
  smtp_secure: 'false',
  smtp_from_email: '',
  smtp_from_name: 'La Grailla',
  google_wallet_issuer_id: '',
  google_wallet_service_account: '',
  apple_wallet_enabled: 'false',
  apple_wallet_pass_type_id: '',
  apple_wallet_team_id: '',
  apple_wallet_cert_p12_base64: '',
  apple_wallet_cert_password: '',
  abacus_ai_api_key: '',
  cookies_banner_enabled: 'true',
  maps_provider: 'osm',
  orders_rate_limit_per_ip: '10',
  orders_rate_limit_window_seconds: '60',
  orders_max_pending_per_ip: '10',
  shop_orders_max_pending_per_ip: '10',
  home_hero_badge_fallback: 'GOOD VIBES DE FERIA',
  home_hero_subtitle_1: 'Caseta de feria, noches de DJ y las mejores vibras de Torremolinos.',
  home_hero_subtitle_2: '¿Te vienes? Compra tus entradas online y asegura tu plaza. 🎉',
  home_events_more_subtitle: 'Otras noches de La Grailla',
  home_shop_title: 'Merch oficial',
  home_shop_subtitle: 'Lleva La Grailla contigo. Bajo pedido.',
  home_about_title: '',
  home_about_text: '',
  home_section_servicios: '',
  home_section_proyectos: '',
  home_section_equipo: '',
  home_section_faq: '',
  contact_form_enabled: 'true',
  home_sponsors_cta_title: '¿Quieres patrocinar nuestros eventos?',
  home_sponsors_cta_subtitle: 'Llega a miles de asistentes. Tu marca en la mejor feria de la costa.',
  footer_tagline: 'Caseta de feria · Eventos · Good Vibes 💜',
  footer_copyright: '© 2025 Grupo La Grailla. Hecho con 🔥 en Málaga.',
  // Impresora térmica Phomemo M04S (taquilla) — valores de fábrica probados en
  // hardware real (phomymo, transcriptionstream/phomymo, issue #23). Ver
  // lib/phomemo/constants.ts DEFAULT_PRINT_SETTINGS, que usa estos mismos valores.
  phomemo_printer_enabled: 'true',
  phomemo_write_mode: 'auto',
  phomemo_raster_chunk_size: '256',
  phomemo_chunk_delay_ms: '20',
  phomemo_command_delay_ms: '30',
  phomemo_after_raster_delay_ms: '300',
  phomemo_after_feed_delay_ms: '500',
  phomemo_density: '6',
  phomemo_feed: '32',
  phomemo_confirm_every_chunks: '8',
};

/** Todas las claves con valor por defecto (para el test que obliga a declarar el módulo dueño de cada una: lib/config-ownership.ts). */
export const CONFIG_DEFAULT_KEYS: readonly string[] = Object.keys(CONFIG_DEFAULTS);

/** Dirección fija de La Grailla: el destinatario de los avisos de operación en la instalación única. */
const LEGACY_OPERATOR_EMAIL = 'grupolagrailla@gmail.com';

/** Claves cuyo valor por defecto es un dato de La Grailla (marca, textos, correo): otro cliente en modo plataforma parte de vacío, nunca de esto. */
const LEGACY_SEED_KEYS = new Set([
  'admin_email',
  'smtp_from_name',
  'home_hero_badge_fallback',
  'home_hero_subtitle_1',
  'home_hero_subtitle_2',
  'home_events_more_subtitle',
  'home_shop_title',
  'home_shop_subtitle',
  'home_sponsors_cta_title',
  'home_sponsors_cta_subtitle',
  'footer_tagline',
  'footer_copyright',
]);

function configDefault(key: string): string {
  if (LEGACY_SEED_KEYS.has(key) && !isLegacyTenant()) return '';
  // El formulario de contacto es del núcleo y viene encendido; La Grailla lo activa cuando quiera (ya tiene su correo de contacto publicado).
  if (key === 'contact_form_enabled') return isLegacyTenant() ? 'false' : 'true';
  return CONFIG_DEFAULTS[key] ?? '';
}

/** Destinatario de los avisos de operación (solicitudes de patrocinio, pagos sobre pedidos anulados, certificados).
 *  Instalación única: La Grailla, como siempre. Modo plataforma: el `admin_email` DEL CLIENTE (el cliente legacy, el suyo o el de
 *  La Grailla si no guardó ninguno) y vacío si un cliente nuevo no lo configuró (quien llama no envía): un aviso con datos
 *  personales nunca puede salir hacia otro cliente. */
export async function getOperatorEmail(scope?: NotificationScope): Promise<string> {
  // Un módulo puede tener su propio destinatario (quien lleva la tienda recibe lo de la tienda): `notify_email_<módulo>`. Vacío o
  // ausente = el de administración, como hasta ahora.
  if (scope) {
    const own = (await getConfig(`notify_email_${scope}`)).trim();
    if (own) return own;
  }
  if (!isPlatformMode()) return LEGACY_OPERATOR_EMAIL;
  return (await getConfig('admin_email')).trim();
}

/** Módulos con destinatario propio de avisos (`notify_email_<scope>` en la configuración). */
export type NotificationScope = 'contacto' | 'entradas' | 'tienda' | 'sponsors';

// Una credencial cifrada que no se puede abrir NO debe confundirse con "sin
// configurar": se registra con el nombre de la clave (nunca el valor) y, según
// quién llame, o se degrada a '' (getConfig/getConfigs, para que una cert de
// Wallet rota no impida enviar el email de entradas) o se propaga
// (getConfigOrThrow, para cobros, donde un error claro vale más que un
// "falta la clave" engañoso).
function decryptConfigValue(key: string, raw: string, strict: boolean): string {
  if (!shouldDecryptOnRead(key)) return raw;
  try {
    return decryptSecret(raw, { configKey: key });
  } catch (err) {
    if (!(err instanceof SecretDecryptionError)) throw err;
    console.error(`[config] No se pudo descifrar "${key}": ${err.message}`);
    if (strict) throw err;
    return '';
  }
}

export async function getConfig(key: string): Promise<string> {
  try {
    const config = await prisma.appConfig.findUnique({ where: { key } });
    return decryptConfigValue(key, config?.value ?? configDefault(key), false);
  } catch {
    return configDefault(key);
  }
}

// Igual que getConfig, pero un valor cifrado ilegible lanza SecretDecryptionError.
// Los errores de BD siguen degradando al valor por defecto.
export async function getConfigOrThrow(key: string): Promise<string> {
  let raw: string;
  try {
    const config = await prisma.appConfig.findUnique({ where: { key } });
    raw = config?.value ?? configDefault(key);
  } catch {
    return configDefault(key);
  }
  return decryptConfigValue(key, raw, true);
}

/** ¿Existe la fila de esta clave? (distinto de "tiene valor": una clave guardada vacía o en «mock» existe). */
export async function hasConfigRow(key: string): Promise<boolean> {
  try {
    return (await prisma.appConfig.findUnique({ where: { key }, select: { key: true } })) !== null;
  } catch {
    return false;
  }
}

export async function getConfigs(keys: string[]): Promise<Record<string, string>> {
  try {
    const configs = await prisma.appConfig.findMany({
      where: { key: { in: keys } },
    });
    const result: Record<string, string> = {};
    for (const k of keys) {
      const found = configs?.find((c) => c?.key === k);
      result[k] = decryptConfigValue(k, found?.value ?? configDefault(k), false);
    }
    return result;
  } catch {
    const result: Record<string, string> = {};
    for (const k of keys) result[k] = configDefault(k);
    return result;
  }
}

/** La BD no respondió al leer la configuración (distinto de «no está configurado»). El mensaje no lleva datos de la conexión. */
export class ConfigReadError extends Error {
  constructor() {
    super('No se pudo leer la configuración (error de base de datos)');
    this.name = 'ConfigReadError';
  }
}

/**
 * Igual que `getConfigs`, pero un fallo de la BD LANZA `ConfigReadError` en vez de degradar a los valores por defecto. Para quien tiene que
 * distinguir «sin configurar» de «no se pudo leer» (el SMTP: un pico de errores de BD no puede diagnosticarse como «No hay SMTP configurado»).
 * Un valor cifrado ilegible sigue degradando a '' como en `getConfigs`.
 */
export async function getConfigsOrFail(keys: string[]): Promise<Record<string, string>> {
  let configs: { key: string; value: string }[];
  try {
    configs = await prisma.appConfig.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  } catch (error) {
    console.error('[config] Error de BD al leer la configuración:', error instanceof Error ? error.name : 'desconocido');
    throw new ConfigReadError();
  }
  const result: Record<string, string> = {};
  for (const k of keys) {
    const found = configs.find((c) => c.key === k);
    result[k] = decryptConfigValue(k, found?.value ?? configDefault(k), false);
  }
  return result;
}

export async function setConfig(key: string, value: string, label?: string, group?: string) {
  const storedValue = isSensitiveConfigKey(key) ? encryptSecret(value, key) : value;
  await prisma.appConfig.upsert({
    where: { key },
    update: { value: storedValue },
    create: { key, value: storedValue, label, group },
  });
}
