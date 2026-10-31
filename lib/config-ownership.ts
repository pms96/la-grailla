import type { ModuleKey } from '@grailla/contracts';
import { ownerEnabled } from '@/lib/modules/registry';
import { SECTION_CONFIG_KEYS, SECTION_KINDS, invalidSectionValue, sectionKindOfKey } from '@/lib/content/sections';

/* A qué módulo(s) pertenece cada clave de configuración (AppConfig). Es pura y no importa Prisma.
 *
 * Antes la API de configuración devolvía y aceptaba TODAS las claves de todos los módulos y la pantalla solo ocultaba pestañas: un cliente
 * sin Entradas seguía viendo y guardando la comisión por entradas. Ahora:
 *  - El GET devuelve solo las claves de módulos activos y el PUT ignora las demás.
 *  - Una clave COMPARTIDA (p. ej. la clave de IA, que usan Contabilidad y Sponsors) lleva varios dueños y existe si cualquiera está activo.
 *  - Una clave sin dueño no se muestra ni se guarda; un test obliga a declarar el dueño de toda clave nueva. */

type Owners = readonly ModuleKey[];

const NUCLEO: Owners = ['nucleo'];
const ENTRADAS: Owners = ['entradas'];
const TIENDA: Owners = ['tienda'];
const WALLETS: Owners = ['wallets'];
const SPONSORS: Owners = ['sponsors'];

const owned = (owners: Owners, keys: string[]): [string, Owners][] => keys.map((k) => [k, owners]);

export const CONFIG_KEY_OWNERS: Readonly<Record<string, Owners>> = Object.fromEntries([
  // Núcleo: contenido, redes, correo, legal, general.
  ...owned(NUCLEO, [
    'legal_notice', 'privacy_policy', 'cookies_policy', 'fiscal_legal_name', 'fiscal_nif', 'fiscal_address',
    'social_instagram', 'social_tiktok', 'social_twitter', 'social_facebook',
    'admin_email', 'smtp_enabled', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_secure', 'smtp_from_email', 'smtp_from_name',
    'cookies_banner_enabled', 'maps_provider', 'contact_form_enabled', 'notify_email_contacto', 'turnstile_site_key', 'turnstile_secret_key',
    'home_hero_badge_fallback', 'home_hero_subtitle_1', 'home_hero_subtitle_2', 'home_about_title', 'home_about_text',
    'footer_tagline', 'footer_copyright',
    // Secciones de contenido de la portada (servicios, proyectos, equipo, preguntas frecuentes): un JSON por sección, ver lib/content/sections.ts.
    ...SECTION_KINDS.map((k) => SECTION_CONFIG_KEYS[k]),
  ]),
  // Entradas: su cuenta de cobro, la comisión, los límites de compra y la impresora de taquilla.
  ...owned(ENTRADAS, [
    'payment_gateway', 'stripe_publishable_key', 'stripe_secret_key', 'stripe_webhook_secret', 'sumup_api_key', 'sumup_merchant_code',
    'commission_percentage', 'orders_rate_limit_per_ip', 'orders_rate_limit_window_seconds', 'orders_max_pending_per_ip', 'jornada_corte_hora', 'home_events_more_subtitle', 'notify_email_entradas', 'vat_rate_entradas', 'legal_terms_entradas',
    'phomemo_printer_enabled', 'phomemo_write_mode', 'phomemo_raster_chunk_size', 'phomemo_chunk_delay_ms', 'phomemo_command_delay_ms',
    'phomemo_after_raster_delay_ms', 'phomemo_after_feed_delay_ms', 'phomemo_density', 'phomemo_feed', 'phomemo_confirm_every_chunks',
  ]),
  // Tienda: SU propia cuenta de cobro (no comparte la de Entradas) y los textos de su sección.
  ...owned(TIENDA, [
    'shop_payment_gateway', 'shop_stripe_publishable_key', 'shop_stripe_secret_key', 'shop_stripe_webhook_secret', 'shop_sumup_api_key',
    'shop_sumup_merchant_code', 'shop_orders_max_pending_per_ip', 'home_shop_title', 'home_shop_subtitle', 'notify_email_tienda', 'vat_rate_tienda', 'legal_terms_tienda',
  ]),
  ...owned(WALLETS, [
    'google_wallet_issuer_id', 'google_wallet_service_account', 'apple_wallet_enabled', 'apple_wallet_pass_type_id', 'apple_wallet_team_id',
    'apple_wallet_cert_p12_base64', 'apple_wallet_cert_password',
  ]),
  ...owned(SPONSORS, ['sponsor_tiers', 'sponsor_payment_pending_message', 'home_sponsors_cta_title', 'home_sponsors_cta_subtitle', 'notify_email_sponsors']),
  // Compartida: la usan la extracción de artículos de Contabilidad y el vídeo IA de Sponsors.
  ['abacus_ai_api_key', ['contabilidad', 'sponsors'] as Owners],
]);

/**
 * Claves que SOLO toca el propietario, aunque su dueño sea el núcleo: el correo saliente y `admin_email`. Un rol restringido con el módulo núcleo
 * («Contenido y mensajes») podría, si no, sustituir el SMTP y desviar los correos con datos de compradores a su propio servidor (P1-03).
 */
export const OWNER_ONLY_CONFIG_KEYS: readonly string[] = [
  'admin_email', 'smtp_enabled', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_secure', 'smtp_from_email', 'smtp_from_name',
];

/** Claves del sistema: ni se muestran ni se guardan desde la API de administración (el tema tiene su propia ruta). */
export const INTERNAL_CONFIG_KEYS: readonly string[] = [
  'site_theme',
  'apple_wallet_cert_expiry_alerted_for',
  // Resumen de la última pasada del cron de reconciliación, para el bloque `ops` de /api/health (lib/ops-health.ts). Lo escribe el cron; no es secreto.
  'ops_reconcile_last',
  // Resultado de la última conciliación diaria con la pasarela (lib/reconciliation/gateway.ts); también lo escribe el sistema.
  'ops_gateway_last',
];

/** Módulos dueños de una clave, o null si no tiene dueño declarado. */
export function configKeyOwners(key: string): Owners | null {
  return CONFIG_KEY_OWNERS[key] ?? null;
}

/**
 * ¿Se puede ver y guardar esta clave con estos módulos activos? Desconocida o interna: nunca.
 * `userModules`: los módulos del rol de quien lo pide (null/undefined = propietario). Un rol restringido solo toca las claves de SUS
 * módulos: un gestor de tienda no ve el correo saliente (núcleo) ni la cuenta de cobro de Entradas.
 */
export function isConfigKeyAllowed(key: string, activeModules: readonly ModuleKey[], userModules?: readonly string[] | null): boolean {
  if (INTERNAL_CONFIG_KEYS.includes(key)) return false;
  if (userModules != null && OWNER_ONLY_CONFIG_KEYS.includes(key)) return false;
  const owners = configKeyOwners(key);
  return owners !== null && owners.some((m) => ownerEnabled(m, activeModules) && (userModules == null || userModules.includes(m)));
}

type Rule = { kind: 'bool' } | { kind: 'int'; min: number; max: number } | { kind: 'percent' } | { kind: 'email' } | { kind: 'enum'; values: string[] };

const BOOL: Rule = { kind: 'bool' };
const RULES: Record<string, Rule> = {
  smtp_enabled: BOOL,
  smtp_secure: BOOL,
  apple_wallet_enabled: BOOL,
  cookies_banner_enabled: BOOL,
  contact_form_enabled: BOOL,
  phomemo_printer_enabled: BOOL,
  commission_percentage: { kind: 'percent' },
  vat_rate_entradas: { kind: 'percent' },
  vat_rate_tienda: { kind: 'percent' },
  orders_rate_limit_per_ip: { kind: 'int', min: 1, max: 1000 },
  orders_rate_limit_window_seconds: { kind: 'int', min: 1, max: 86_400 },
  orders_max_pending_per_ip: { kind: 'int', min: 1, max: 1000 },
  shop_orders_max_pending_per_ip: { kind: 'int', min: 1, max: 1000 },
  jornada_corte_hora: { kind: 'int', min: 0, max: 12 },
  smtp_port: { kind: 'int', min: 1, max: 65_535 },
  phomemo_density: { kind: 'int', min: 1, max: 8 },
  phomemo_feed: { kind: 'int', min: 0, max: 255 },
  phomemo_raster_chunk_size: { kind: 'int', min: 1, max: 4096 },
  phomemo_chunk_delay_ms: { kind: 'int', min: 0, max: 10_000 },
  phomemo_command_delay_ms: { kind: 'int', min: 0, max: 10_000 },
  phomemo_after_raster_delay_ms: { kind: 'int', min: 0, max: 10_000 },
  phomemo_after_feed_delay_ms: { kind: 'int', min: 0, max: 10_000 },
  phomemo_confirm_every_chunks: { kind: 'int', min: 0, max: 1000 },
  phomemo_write_mode: { kind: 'enum', values: ['auto', 'with_response', 'without_response'] },
  payment_gateway: { kind: 'enum', values: ['mock', 'stripe', 'sumup'] },
  shop_payment_gateway: { kind: 'enum', values: ['mock', 'stripe', 'sumup'] },
  admin_email: { kind: 'email' },
  smtp_from_email: { kind: 'email' },
  notify_email_contacto: { kind: 'email' },
  notify_email_entradas: { kind: 'email' },
  notify_email_tienda: { kind: 'email' },
  notify_email_sponsors: { kind: 'email' },
};

/** Motivo por el que el valor no es válido para esa clave, o null si lo es. El valor vacío siempre vale ("usar el de por defecto"). */
export function invalidConfigValue(key: string, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  // Secciones de contenido de la portada: JSON con sus propios límites (ver lib/content/sections.ts).
  const sectionKind = sectionKindOfKey(key);
  if (sectionKind) return invalidSectionValue(v, sectionKind);
  const rule = RULES[key];
  if (!rule) return null;
  switch (rule.kind) {
    case 'bool':
      return v === 'true' || v === 'false' ? null : 'debe ser «true» o «false»';
    case 'percent': {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? null : 'debe ser un porcentaje entre 0 y 100';
    }
    case 'int': {
      const n = Number(v);
      return Number.isInteger(n) && n >= rule.min && n <= rule.max ? null : `debe ser un número entero entre ${rule.min} y ${rule.max}`;
    }
    case 'enum':
      return rule.values.includes(v) ? null : `debe ser uno de: ${rule.values.join(', ')}`;
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'debe ser un email válido';
  }
}
