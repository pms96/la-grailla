import { moduleObligations } from '@grailla/contracts';
import { probeTenantHealth } from './health';
import type { FetchLike } from './tenant-calls';

/* Guardas para apagar un módulo (P1-20). Quitar Entradas o Tienda a un cliente con compradores a medias deja pagos sin resolver, personas con
 * entrada para un evento próximo y paquetes sin enviar. El panel pregunta al front del cliente (su salud, con el secreto de ese cliente) por las
 * obligaciones abiertas y se niega a quitar el módulo mientras las haya, salvo anulación con motivo que queda en la auditoría. */

/** Módulos que dejan obligaciones medibles hoy (ver `moduleObligations`). */
export const GUARDED_MODULES: readonly string[] = ['entradas', 'tienda'];

export interface RemovalCheck {
  /** Obligaciones abiertas, en claro y con su cifra. */
  blockers: string[];
  /** Por qué no se pudo comprobar (la web no responde, o el front no informa de sus obligaciones). null = se comprobó. */
  unverified: string | null;
}

/**
 * ¿Se pueden quitar estos módulos ahora? Sin ningún módulo con guarda, o sin dominio verificado (el cliente aún no está en marcha, no hay
 * compradores), no hay nada que comprobar. Con dominio verificado, si NO se puede medir se trata como no verificado: apagar es destructivo,
 * así que ante la duda se pide anulación con motivo en lugar de dejar pasar.
 */
export async function checkModuleRemoval(
  sub: { tenantId: string; schemaVersion: string | null; domains: { host: string; status: string; isPrimary: boolean }[] },
  removed: string[],
  opts: { healthFetch?: FetchLike } = {}
): Promise<RemovalCheck> {
  const guarded = removed.filter((m) => GUARDED_MODULES.includes(m));
  if (guarded.length === 0) return { blockers: [], unverified: null };
  const verified = sub.domains.filter((d) => d.status === 'VERIFIED');
  const host = (verified.find((d) => d.isPrimary) ?? verified[0])?.host;
  if (!host) return { blockers: [], unverified: null };
  const probe = await probeTenantHealth({ tenantId: sub.tenantId, host, declaredSchema: sub.schemaVersion }, { fetchImpl: opts.healthFetch, timeoutMs: 8_000 });
  if (!probe.reachable) return { blockers: [], unverified: 'La web del cliente no responde: no se pueden comprobar sus pedidos y eventos' };
  const obligations = probe.ops?.obligations;
  if (!obligations) return { blockers: [], unverified: 'El front del cliente no informa de sus obligaciones abiertas (versión anterior o no se pudieron medir)' };
  return { blockers: guarded.flatMap((m) => moduleObligations(m, obligations)), unverified: null };
}
