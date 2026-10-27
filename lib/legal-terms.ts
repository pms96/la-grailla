import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { getConfigsOrFail } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';
import { currentTenant } from '@/lib/tenant/context';
import { captureOpsError } from '@/lib/observability/capture';
import { defaultTermsEntradas, defaultTermsTienda } from '@/lib/legal-defaults';
import { getFiscalIssuer } from '@/lib/fiscal';

/* P0-11 · Condiciones de venta y registro de lo que aceptó el comprador.
 *
 * El texto vigente es el que el cliente escribió en Configuración → Legal o, si no escribió nada, el borrador por defecto. Al crear un pedido
 * se calcula el hash de los textos que el comprador estaba viendo (condiciones + privacidad + condiciones del evento) y se guarda una copia en
 * LegalSnapshot (una vez por versión distinta): el pedido apunta a ella con `termsVersion`, así se puede demostrar qué aceptó aunque las
 * condiciones cambien después. */

export type TermsKind = 'entradas' | 'tienda';

export const TERMS_CONFIG_KEY: Record<TermsKind, string> = { entradas: 'legal_terms_entradas', tienda: 'legal_terms_tienda' };

/** Las condiciones de venta vigentes (las del cliente o el borrador) y si son el borrador. Lanza si la BD no responde. */
export async function getTermsText(kind: TermsKind): Promise<{ text: string; isDefault: boolean }> {
  const key = TERMS_CONFIG_KEY[kind];
  const own = (await getConfigsOrFail([key]))[key].trim();
  if (own) return { text: own, isDefault: false };
  // Solo el borrador necesita la marca y los datos fiscales: con texto propio (el caso normal) no se hacen esas lecturas en cada pedido.
  const [brand, issuer] = await Promise.all([getBrand(), getFiscalIssuer()]);
  const ctx = { name: issuer?.name ?? brand.legalName, nif: issuer?.nif, address: issuer?.address, email: brand.contactEmail || undefined };
  return { text: kind === 'entradas' ? defaultTermsEntradas(ctx) : defaultTermsTienda(ctx), isDefault: true };
}

/** Hash estable (32 hex) del contenido: mismo texto, mismo hash. */
export function legalHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

// Versiones ya guardadas en ESTE proceso y cliente (la clave lleva el cliente: la misma versión en dos BD no es la misma fila).
const recorded = new Set<string>();
const MAX_RECORDED = 500;

/**
 * Registra la versión de condiciones que el comprador está aceptando y devuelve su hash para guardarlo en el pedido. `extra` = texto
 * propio del evento (condiciones de acceso). Si la copia no se puede guardar NO se bloquea la venta (se avisa a operación); el pedido
 * conserva igualmente el hash y la fecha. Lanza solo si la configuración no se puede leer (en ese caso la venta tampoco debe seguir).
 */
export async function recordTermsVersion(kind: TermsKind, extra = ''): Promise<string> {
  const [{ text }, priv] = await Promise.all([getTermsText(kind), getConfigsOrFail(['privacy_policy'])]);
  const content = JSON.stringify({ kind, terms: text, privacy: priv.privacy_policy.trim(), extra: extra.trim() });
  const hash = legalHash(content);
  const cacheKey = `${currentTenant()?.tenantId ?? 'single'}:${hash}`;
  if (!recorded.has(cacheKey)) {
    try {
      await prisma.legalSnapshot.upsert({ where: { hash }, update: {}, create: { hash, kind, content } });
      if (recorded.size >= MAX_RECORDED) recorded.clear();
      recorded.add(cacheKey);
    } catch (error) {
      captureOpsError(error, { route: 'legal-snapshot', kind, reason: 'snapshot_not_saved' });
    }
  }
  return hash;
}
