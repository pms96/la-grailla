import { prisma } from '@/lib/prisma';
import { SecretDecryptionError, decryptSecret, encryptSecret, isSensitiveConfigKey, shouldDecryptOnRead } from '@/lib/secrets';
import { DEFAULT_SPONSOR_TIERS } from '@/lib/sponsor-tiers';

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
  home_hero_badge_fallback: 'GOOD VIBES DE FERIA',
  home_hero_subtitle_1: 'Caseta de feria, noches de DJ y las mejores vibras de Torremolinos.',
  home_hero_subtitle_2: '¿Te vienes? Compra tus entradas online y asegura tu plaza. 🎉',
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
    return decryptConfigValue(key, config?.value ?? CONFIG_DEFAULTS[key] ?? '', false);
  } catch {
    return CONFIG_DEFAULTS[key] ?? '';
  }
}

// Igual que getConfig, pero un valor cifrado ilegible lanza SecretDecryptionError.
// Los errores de BD siguen degradando al valor por defecto.
export async function getConfigOrThrow(key: string): Promise<string> {
  let raw: string;
  try {
    const config = await prisma.appConfig.findUnique({ where: { key } });
    raw = config?.value ?? CONFIG_DEFAULTS[key] ?? '';
  } catch {
    return CONFIG_DEFAULTS[key] ?? '';
  }
  return decryptConfigValue(key, raw, true);
}

export async function getConfigs(keys: string[]): Promise<Record<string, string>> {
  try {
    const configs = await prisma.appConfig.findMany({
      where: { key: { in: keys } },
    });
    const result: Record<string, string> = {};
    for (const k of keys) {
      const found = configs?.find((c) => c?.key === k);
      result[k] = decryptConfigValue(k, found?.value ?? CONFIG_DEFAULTS[k] ?? '', false);
    }
    return result;
  } catch {
    const result: Record<string, string> = {};
    for (const k of keys) result[k] = CONFIG_DEFAULTS[k] ?? '';
    return result;
  }
}

export async function setConfig(key: string, value: string, label?: string, group?: string) {
  const storedValue = isSensitiveConfigKey(key) ? encryptSecret(value, key) : value;
  await prisma.appConfig.upsert({
    where: { key },
    update: { value: storedValue },
    create: { key, value: storedValue, label, group },
  });
}
