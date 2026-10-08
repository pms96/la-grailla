import type { OperatorRole } from '@prisma/client';

export type Permission = 'view' | 'tenants:write' | 'publish' | 'domains:verify-manual' | 'database:write' | 'billing:write' | 'tenants:revoke' | 'operators:manage' | 'migrations:run';

// Mínimo privilegio: lo que no está aquí no se puede hacer.
const MATRIX: Record<OperatorRole, readonly Permission[]> = {
  VIEWER: ['view'],
  OPERATOR: ['view', 'tenants:write', 'publish', 'tenants:revoke', 'migrations:run'],
  // Facturación publica: registrar un pago o canjear una clave debe llegar a la web del cliente sin esperar a otro operador.
  BILLING: ['view', 'billing:write', 'publish'],
  SUPERADMIN: ['view', 'tenants:write', 'publish', 'domains:verify-manual', 'database:write', 'billing:write', 'tenants:revoke', 'operators:manage', 'migrations:run'],
};

export function can(role: OperatorRole, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export class ForbiddenError extends Error {
  constructor(permission: Permission) {
    super(`No tienes permiso para esta acción (${permission})`);
    this.name = 'ForbiddenError';
  }
}

export function assertCan(role: OperatorRole, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission);
}
