import { prisma } from '@/lib/prisma';
import { decryptSecret, encryptSecret, isSensitiveConfigKey } from '@/lib/secrets';

const CONFIG_DEFAULTS: Record<string, string> = {
  payment_gateway: 'mock',
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
  cookies_banner_enabled: 'true',
  maps_provider: 'osm',
  orders_rate_limit_per_ip: '10',
  orders_rate_limit_window_seconds: '60',
};

export async function getConfig(key: string): Promise<string> {
  try {
    const config = await prisma.appConfig.findUnique({ where: { key } });
    const raw = config?.value ?? CONFIG_DEFAULTS[key] ?? '';
    return isSensitiveConfigKey(key) ? decryptSecret(raw) : raw;
  } catch {
    return CONFIG_DEFAULTS[key] ?? '';
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
      const raw = found?.value ?? CONFIG_DEFAULTS[k] ?? '';
      result[k] = isSensitiveConfigKey(k) ? decryptSecret(raw) : raw;
    }
    return result;
  } catch {
    const result: Record<string, string> = {};
    for (const k of keys) result[k] = CONFIG_DEFAULTS[k] ?? '';
    return result;
  }
}

export async function setConfig(key: string, value: string, label?: string, group?: string) {
  const storedValue = isSensitiveConfigKey(key) ? encryptSecret(value) : value;
  await prisma.appConfig.upsert({
    where: { key },
    update: { value: storedValue },
    create: { key, value: storedValue, label, group },
  });
}
