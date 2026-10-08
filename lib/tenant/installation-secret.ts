import crypto from 'node:crypto';
import { installationInfo, installationSalt, parseMasterKey, toBase64Url } from '@grailla/contracts';
import { requireTenant, TenantContextError, type TenantContext } from './context';
import { isPlatformMode, legacyTenantId } from './mode';

/* Único sitio del runtime Node que decide "qué secreto uso para este cliente". Sustituye a las lecturas directas de
 * process.env.NEXTAUTH_SECRET (sesión, tokens de acceso, valores enc:v1).
 *
 *  - Modo normal: NEXTAUTH_SECRET, como siempre.
 *  - Modo plataforma, cliente legacy: LEGACY_NEXTAUTH_SECRET (el mismo valor que tenía NEXTAUTH_SECRET), así las sesiones, los
 *    enlaces ya enviados y las credenciales enc:v1 de La Grailla siguen valiendo tras migrar.
 *  - Modo plataforma, resto de clientes: derivado de PLATFORM_SESSION_MASTER + tenantId + época. La cookie de un cliente no abre
 *    otro, y subir la época de un cliente invalida solo sus sesiones y tokens. */

export type SecretPurpose = 'session' | 'access' | 'config-v1';

export function isLegacyTenant(ctx: Pick<TenantContext, 'tenantId'>): boolean {
  const legacy = legacyTenantId();
  return legacy !== null && ctx.tenantId === legacy;
}

/** Misma derivación que `deriveInstallationSecret` (WebCrypto, edge) pero síncrona; hay un test de igualdad. */
export function deriveInstallationSecretSync(master: Uint8Array, tenantId: string, epoch: number, purpose: 'session' | 'access'): string {
  const bits = crypto.hkdfSync('sha256', Buffer.from(master), Buffer.from(installationSalt(tenantId, epoch), 'utf8'), Buffer.from(installationInfo(purpose), 'utf8'), 32);
  return toBase64Url(new Uint8Array(bits));
}

export function sessionMasterKey(): Uint8Array {
  const raw = process.env.PLATFORM_SESSION_MASTER;
  if (!raw) throw new TenantContextError('PLATFORM_SESSION_MASTER no está definido');
  return parseMasterKey(raw);
}

export function getInstallationSecret(purpose: SecretPurpose): string {
  if (!isPlatformMode()) {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) throw new Error('NEXTAUTH_SECRET no está definido — es necesario para firmar sesiones, tokens de acceso y cifrar credenciales');
    return secret;
  }
  const ctx = requireTenant();
  if (isLegacyTenant(ctx)) {
    const secret = process.env.LEGACY_NEXTAUTH_SECRET;
    if (!secret) throw new TenantContextError('LEGACY_NEXTAUTH_SECRET no está definido para el cliente legacy');
    return secret;
  }
  if (purpose === 'config-v1') {
    // Los valores enc:v1 son del cliente legacy; un cliente nuevo solo tiene enc:v2. Si aparece uno, es un error.
    throw new TenantContextError('Los valores enc:v1 solo se pueden abrir para el cliente legacy');
  }
  return deriveInstallationSecretSync(sessionMasterKey(), ctx.tenantId, ctx.epoch, purpose);
}

export type SecretWriteTarget = { format: 'v1' } | { format: 'v2'; tenantId: string; kid: string };

/**
 * Formato con el que se GUARDAN las credenciales nuevas de un cliente.
 *  - Modo normal y cliente legacy: enc:v1 (así un rollback del código sigue leyéndolas).
 *  - Cliente nuevo: enc:v2 con la clave activa (SECRETS_ACTIVE_KID) y su propio tenantId.
 */
export function secretWriteTarget(): SecretWriteTarget {
  if (!isPlatformMode()) return { format: 'v1' };
  const ctx = requireTenant();
  if (isLegacyTenant(ctx)) return { format: 'v1' };
  const kid = process.env.SECRETS_ACTIVE_KID;
  if (!kid) throw new TenantContextError('SECRETS_ACTIVE_KID no está definido');
  return { format: 'v2', tenantId: ctx.tenantId, kid };
}

/**
 * Tenant con el que se descifra un enc:v2 cuando quien lo lee no lo indica (getConfig, etc.): el del cliente de la petición.
 * Fuera del modo plataforma, el valor histórico "legacy".
 */
export function defaultSecretTenantId(): string {
  return isPlatformMode() ? requireTenant().tenantId : 'legacy';
}
