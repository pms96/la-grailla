/* Modo plataforma: UN despliegue de front sirve a varios clientes, cada uno con su dominio y su BD.
 *
 * Se activa con PLATFORM_MODE=on y SOLO en el proyecto de Vercel `platform`. Apagado (el valor por
 * defecto) el front se comporta exactamente como siempre: una BD, un NEXTAUTH_SECRET, un NEXTAUTH_URL.
 * Se lee en cada llamada (no al importar) para que los tests puedan alternarlo. */

export const isPlatformMode = (): boolean => process.env.PLATFORM_MODE === 'on';

/** Cliente "legacy" (La Grailla): conserva su NEXTAUTH_SECRET y sus valores enc:v1 para no invalidar nada al migrar. */
export const legacyTenantId = (): string | null => process.env.LEGACY_TENANT_ID?.trim() || null;
