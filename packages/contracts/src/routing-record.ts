import { z } from 'zod';
import { isNormalizedHost } from './hosts';
import { ULID_RE } from './ids';

export const LICENSE_PHASES = ['ACTIVE', 'GRACE', 'PANEL_BLOCKED', 'BLOCKED'] as const;
export type LicensePhase = (typeof LICENSE_PHASES)[number];

export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const host = z.string().refine(isNormalizedHost, 'dominio no normalizado');

/** Lo que el front necesita para resolver un Host. NUNCA contiene secretos ni URLs de BD. */
export const RoutingRecordSchema = z
  .object({
    tenantId: z.string().regex(ULID_RE, 'tenantId debe ser un ULID'),
    product: slug,
    // Celda de despliegue (hoy una sola compartida): permite sacar a un cliente a otra sin cambiar el contrato.
    cell: slug,
    status: z.enum(TENANT_STATUSES),
    // Texto libre a propósito: un módulo nuevo del panel no debe invalidar el registro en un front antiguo.
    modules: z.array(z.string().min(1).max(64)).max(64),
    license: z.object({
      phase: z.enum(LICENSE_PHASES),
      // Instante (ms epoch) en que la fase cambiará sola; null si no hay cambio previsto.
      nextPhaseChangeAt: z.number().int().nonnegative().nullable(),
      // Cambios de fase programados (aditivo, opcional): el front los aplica solo con una lectura fresca del registro.
      schedule: z
        .array(z.object({ at: z.number().int().nonnegative(), phase: z.enum(LICENSE_PHASES) }))
        .max(3)
        .optional(),
    }),
    primaryDomain: host,
    domains: z.array(host).min(1).max(50),
    // Última migración aplicada a la BD del cliente (nombre de carpeta), o null si se desconoce.
    schemaVersion: z.string().max(128).nullable(),
    // Sube para invalidar de golpe sesiones y tokens de un solo tenant.
    epoch: z.number().int().nonnegative(),
  })
  .refine((r) => r.domains.includes(r.primaryDomain), {
    message: 'primaryDomain debe estar en domains',
    path: ['primaryDomain'],
  })
  .refine((r) => new Set(r.domains).size === r.domains.length, {
    message: 'domains con duplicados',
    path: ['domains'],
  });

export type RoutingRecord = z.infer<typeof RoutingRecordSchema>;
