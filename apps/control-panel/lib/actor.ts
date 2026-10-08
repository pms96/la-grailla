import type { OperatorRole } from '@prisma/client';
import type { Actor } from './audit';

/** Quien ejecuta una acción: se pasa a cada servicio, que comprueba el permiso por dentro. */
export type ActingOperator = Actor & { id: string; role: OperatorRole };
