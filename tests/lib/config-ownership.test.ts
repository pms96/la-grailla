import { describe, it, expect } from 'vitest';
import { CONFIG_DEFAULT_KEYS } from '@/lib/config';
import { INTERNAL_CONFIG_KEYS, OWNER_ONLY_CONFIG_KEYS, configKeyOwners, invalidConfigValue, isConfigKeyAllowed } from '@/lib/config-ownership';

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

  it('el propietario (sin rol restringido) las ve y las guarda', () => {
    for (const k of OWNER_ONLY_CONFIG_KEYS) {
      expect(isConfigKeyAllowed(k, nucleoActivo), k).toBe(true);
      expect(isConfigKeyAllowed(k, nucleoActivo, null), k).toBe(true);
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
    for (const k of OWNER_ONLY_CONFIG_KEYS) expect(CONFIG_DEFAULT_KEYS, k).toContain(k);
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
