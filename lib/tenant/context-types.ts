import type { LicensePhase } from '@grailla/contracts';

/* Tipos y constantes del contexto de cliente que comparten el middleware (edge) y el runtime Node.
 * Este archivo NO puede importar nada de Node (crypto, next/headers...): lo bundlea el edge. */

export type TenantContext = {
  tenantId: string;
  product: string;
  /** Host tal cual llegó (puede llevar puerto en desarrollo). */
  host: string;
  /** Dominio principal verificado: de aquí salen TODAS las URLs absolutas (emails, pagos, wallet, sitemap). */
  primaryDomain: string;
  epoch: number;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION' | 'DELETED';
  modules: string[];
  /** Licencia: tras el resolutor lleva la fase del snapshot y su calendario; el middleware la sustituye por la fase EFECTIVA ahora. Ausente = ACTIVE. */
  license?: { phase: LicensePhase; nextPhaseChangeAt: number | null; schedule?: { at: number; phase: LicensePhase }[] };
  /** Última migración aplicada a la BD del cliente según el registro (nombre de carpeta), o null si se desconoce. Lo usa la puerta de esquema (M7). */
  schemaVersion?: string | null;
  /** URLs de la BD del cliente SELLADAS (enc:v2): solo se abren en Node con la clave maestra del servidor. */
  db: { pooledEnc: string; directEnc: string };
  /** Solo tests: URL de BD en claro. Se ignora fuera de Vitest. */
  testDbUrl?: string;
};

export const CONTEXT_HEADER = 'x-grailla-ctx';
