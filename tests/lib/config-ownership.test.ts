import { describe, it, expect } from 'vitest';
import { CONFIG_DEFAULT_KEYS } from '@/lib/config';
import { CONFIG_KEY_OWNERS, INTERNAL_CONFIG_KEYS, OWNER_ONLY_CONFIG_KEYS, configKeyOwners, invalidConfigValue, isConfigKeyAllowed } from '@/lib/config-ownership';

// Revisión de módulos (2026-10): la API de configuración devolvía y aceptaba TODAS las claves de todos los módulos; la pantalla solo
// ocultaba pestañas. Cada clave debe declarar a qué módulo(s) pertenece, y una clave nueva sin dueño debe romper la CI.
describe('Propietario de cada clave de configuración', () => {
  it('toda clave con valor por defecto declara su propietario (una clave nueva sin dueño rompe este test)', () => {
    const sinDueno = CONFIG_DEFAULT_KEYS.filter((k) => !INTERNAL_CONFIG_KEYS.includes(k) && configKeyOwners(k) === null);
    expect(sinDueno).toEqual([]);
  });

  it('la comisión por entradas es solo de Entradas; el correo de administración es del núcleo', () => {
    expect(configKeyOwners('commission_percentage')).toEqual(['entradas']);
    expect(configKeyOwners('admin_email')).toEqual(['nucleo']);
  });

  it('la clave de IA es compartida por Contabilidad y Sponsors', () => {
    expect([...(configKeyOwners('abacus_ai_api_key') ?? [])].sort()).toEqual(['contabilidad', 'sponsors']);
  });

  it('cada módulo con cobro tiene su propia cuenta: las claves de la tienda no son las de Entradas', () => {
    expect(configKeyOwners('shop_payment_gateway')).toEqual(['tienda']);
    expect(configKeyOwners('shop_sumup_api_key')).toEqual(['tienda']);
    expect(configKeyOwners('sumup_api_key')).toEqual(['entradas']);
  });

  it('una clave solo se permite si alguno de sus módulos está activo', () => {
    expect(isConfigKeyAllowed('commission_percentage', ['nucleo'])).toBe(false);
    expect(isConfigKeyAllowed('commission_percentage', ['nucleo', 'entradas'])).toBe(true);
    expect(isConfigKeyAllowed('admin_email', ['nucleo'])).toBe(true);
    expect(isConfigKeyAllowed('abacus_ai_api_key', ['nucleo', 'contabilidad'])).toBe(true);
    expect(isConfigKeyAllowed('abacus_ai_api_key', ['nucleo', 'tienda'])).toBe(false);
    expect(isConfigKeyAllowed('apple_wallet_team_id', ['nucleo', 'wallets'])).toBe(false); // Wallets exige Entradas o Tienda
    expect(isConfigKeyAllowed('apple_wallet_team_id', ['nucleo', 'wallets', 'entradas'])).toBe(true);
  });

  it('una clave desconocida o interna nunca se permite', () => {
    expect(isConfigKeyAllowed('clave_inventada', ['nucleo', 'entradas', 'tienda'])).toBe(false);
    expect(isConfigKeyAllowed('apple_wallet_cert_expiry_alerted_for', ['nucleo', 'wallets', 'entradas'])).toBe(false);
  });
});

describe('Validación del valor de cada clave', () => {
  it('los interruptores solo admiten true o false', () => {
    expect(invalidConfigValue('smtp_enabled', 'true')).toBeNull();
    expect(invalidConfigValue('smtp_enabled', 'sí')).not.toBeNull();
    expect(invalidConfigValue('contact_form_enabled', 'False')).not.toBeNull();
  });

  it('la comisión es un porcentaje de 0 a 100', () => {
    expect(invalidConfigValue('commission_percentage', '12.5')).toBeNull();
    expect(invalidConfigValue('commission_percentage', '-1')).not.toBeNull();
    expect(invalidConfigValue('commission_percentage', '101')).not.toBeNull();
    expect(invalidConfigValue('commission_percentage', 'abc')).not.toBeNull();
  });

  it('la hora de corte de la jornada es un entero de 0 a 12 (P1-15)', () => {
    for (const ok of ['0', '6', '12']) expect(invalidConfigValue('jornada_corte_hora', ok), ok).toBeNull();
    for (const bad of ['-1', '13', '6.5', 'seis']) expect(invalidConfigValue('jornada_corte_hora', bad), bad).not.toBeNull();
    expect(invalidConfigValue('jornada_corte_hora', '')).toBeNull(); // vacío = valor por defecto (0), como en el resto de claves
  });

  it('los límites y el puerto son enteros dentro de su rango', () => {
    expect(invalidConfigValue('orders_rate_limit_per_ip', '10')).toBeNull();
    expect(invalidConfigValue('orders_rate_limit_per_ip', '0')).not.toBeNull();
    expect(invalidConfigValue('smtp_port', '587')).toBeNull();
    expect(invalidConfigValue('smtp_port', '70000')).not.toBeNull();
  });

  it('el valor vacío se acepta siempre (significa "usar el de por defecto")', () => {
    expect(invalidConfigValue('commission_percentage', '')).toBeNull();
    expect(invalidConfigValue('smtp_enabled', '')).toBeNull();
    expect(invalidConfigValue('admin_email', '')).toBeNull();
  });

  it('el email de administración debe parecer un email', () => {
    expect(invalidConfigValue('admin_email', 'dueno@cliente.es')).toBeNull();
    expect(invalidConfigValue('admin_email', 'no-es-un-email')).not.toBeNull();
  });

  it('las claves de texto libre no se validan', () => {
    expect(invalidConfigValue('legal_notice', 'cualquier cosa')).toBeNull();
  });
});

/* P1-03: el rol «Contenido y mensajes» tiene el módulo núcleo, dueño del SMTP y de `admin_email`. Si pudiera cambiarlos, desviaría los correos
 * con datos de compradores. Esas claves son solo del propietario (sin restricción de módulos). */
describe('Claves solo del propietario (correo saliente)', () => {
  const nucleoActivo = ['nucleo', 'entradas', 'tienda'] as const;

  const todosActivos = ['nucleo', 'entradas', 'tienda', 'contabilidad', 'sponsors', 'wallets'] as const;

  it('el propietario (sin rol restringido) las ve y las guarda', () => {
    for (const k of OWNER_ONLY_CONFIG_KEYS) {
      expect(isConfigKeyAllowed(k, todosActivos), k).toBe(true);
      expect(isConfigKeyAllowed(k, todosActivos, null), k).toBe(true);
    }
  });

  it('un rol restringido, aunque tenga el núcleo, NO puede verlas ni guardarlas', () => {
    for (const k of OWNER_ONLY_CONFIG_KEYS) {
      expect(isConfigKeyAllowed(k, nucleoActivo, ['nucleo']), k).toBe(false);
      expect(isConfigKeyAllowed(k, nucleoActivo, ['nucleo', 'entradas', 'tienda']), k).toBe(false);
    }
  });

  it('cubren todo el SMTP y el email de administración, y existen como claves de configuración', () => {
    const smtp = CONFIG_DEFAULT_KEYS.filter((k) => k.startsWith('smtp_'));
    expect(smtp.length).toBeGreaterThan(0);
    for (const k of smtp) expect(OWNER_ONLY_CONFIG_KEYS, k).toContain(k);
    expect(OWNER_ONLY_CONFIG_KEYS).toContain('admin_email');
    // Evita erratas: cada clave de la lista existe (con valor por defecto, o al menos con dueño declarado: las `shop_*` no tienen valor por defecto).
    for (const k of OWNER_ONLY_CONFIG_KEYS) expect(CONFIG_DEFAULT_KEYS.includes(k) || k in CONFIG_KEY_OWNERS, k).toBe(true);
  });

  // H-058: un «Gestor de entradas» podía sustituir `stripe_secret_key` o `sumup_api_key` y desviar todo cobro online a su cuenta; con su propio
  // `stripe_webhook_secret` firmaba webhooks falsos; el rol «Contenido» apagaba el captcha (`turnstile_*`) y cambiaba los datos fiscales de los justificantes.
  it('las credenciales de pago, el captcha, los datos fiscales y las claves de wallet y de IA son solo del propietario', () => {
    const exigidas = [
      'payment_gateway', 'stripe_publishable_key', 'stripe_secret_key', 'stripe_webhook_secret', 'sumup_api_key', 'sumup_merchant_code',
      'shop_payment_gateway', 'shop_stripe_publishable_key', 'shop_stripe_secret_key', 'shop_stripe_webhook_secret', 'shop_sumup_api_key', 'shop_sumup_merchant_code',
      'google_wallet_issuer_id', 'google_wallet_service_account', 'apple_wallet_cert_p12_base64', 'apple_wallet_cert_password', 'abacus_ai_api_key',
      'turnstile_site_key', 'turnstile_secret_key', 'fiscal_legal_name', 'fiscal_nif', 'fiscal_address',
    ];
    for (const k of exigidas) expect(OWNER_ONLY_CONFIG_KEYS, k).toContain(k);
  });

  it('invariante: toda clave con nombre de cobro, captcha, fiscal, certificado o IA está en la lista del propietario (una clave nueva no se cuela)', () => {
    const sensible = /stripe|sumup|payment_gateway|turnstile|fiscal_|wallet_(service_account|issuer|cert|team|pass_type)|abacus/i;
    const fuera = Object.keys(CONFIG_KEY_OWNERS).filter((k) => sensible.test(k) && !OWNER_ONLY_CONFIG_KEYS.includes(k));
    expect(fuera).toEqual([]);
  });

  it('un gestor de entradas no toca la cuenta de cobro pero sí la comisión; el rol de contenido no toca captcha ni fiscales', () => {
    expect(isConfigKeyAllowed('stripe_secret_key', todosActivos, ['entradas'])).toBe(false);
    expect(isConfigKeyAllowed('sumup_merchant_code', todosActivos, ['entradas'])).toBe(false);
    expect(isConfigKeyAllowed('shop_stripe_secret_key', todosActivos, ['tienda'])).toBe(false);
    expect(isConfigKeyAllowed('commission_percentage', todosActivos, ['entradas'])).toBe(true);
    expect(isConfigKeyAllowed('turnstile_secret_key', todosActivos, ['nucleo'])).toBe(false);
    expect(isConfigKeyAllowed('fiscal_nif', todosActivos, ['nucleo'])).toBe(false);
    expect(isConfigKeyAllowed('stripe_secret_key', todosActivos, null)).toBe(true);
  });

  it('el resto de claves del núcleo siguen siendo de un rol con el núcleo (contenido, redes, legal)', () => {
    for (const k of ['social_instagram', 'home_about_text', 'legal_notice', 'notify_email_contacto', 'cookies_banner_enabled']) {
      expect(isConfigKeyAllowed(k, nucleoActivo, ['nucleo']), k).toBe(true);
    }
  });
});

describe('Claves de trabajos de evento (P1-04)', () => {
  it('las filas internas de cancelación y cambio de fecha de evento no se ven ni se guardan desde la API de configuración', () => {
    for (const k of ['event_cancellation:abc123', 'event_datechange:abc123']) {
      expect(isConfigKeyAllowed(k, ['nucleo', 'entradas', 'tienda', 'contabilidad', 'sponsors', 'wallets']), k).toBe(false);
      expect(isConfigKeyAllowed(k, ['nucleo', 'entradas'], null), k).toBe(false);
    }
  });
});
