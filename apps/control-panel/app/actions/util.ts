import { ForbiddenError } from '@/lib/permissions';
import { ServiceError } from '@/lib/services/errors';
import type { ActionState } from '../_components/action-form';

/** Convierte un error esperado en mensaje para el operador; los inesperados no filtran detalles. */
export function toState(err: unknown): ActionState {
  if (err instanceof ServiceError || err instanceof ForbiddenError) return { error: err.message };
  // Las redirecciones de Next se lanzan como excepción y deben seguir su camino.
  if (err && typeof err === 'object' && 'digest' in err && String((err as { digest: unknown }).digest).startsWith('NEXT_REDIRECT')) throw err;
  console.error('[control-panel] error inesperado', err);
  return { error: 'Ha ocurrido un error inesperado. Consulta los registros del servidor.' };
}

export const str = (fd: FormData, key: string): string => {
  const v = fd.get(key);
  return typeof v === 'string' ? v : '';
};
