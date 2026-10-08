'use server';

import { revalidatePath } from 'next/cache';
import { requireOperator } from '@/lib/guard';
import { createOperator, resetOperatorCredentials, setOperatorDisabled, setOperatorRole } from '@/lib/services/auth';
import type { ActionState } from '../_components/action-form';
import { str, toState } from './util';

const ROLES = ['VIEWER', 'OPERATOR', 'BILLING', 'SUPERADMIN'] as const;
type Role = (typeof ROLES)[number];
const asRole = (v: string): Role => (ROLES as readonly string[]).includes(v) ? (v as Role) : 'VIEWER';

export async function createOperatorAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { actor } = await requireOperator('operators:manage');
    const { operator, temporaryPassword } = await createOperator({ email: str(fd, 'email'), name: str(fd, 'name'), role: asRole(str(fd, 'role')) }, actor);
    revalidatePath('/operators');
    return {
      ok: `Operador ${operator.email} creado.`,
      reveal: {
        title: 'Contraseña temporal',
        lines: [temporaryPassword],
        note: 'Se muestra una sola vez. Tendrá que cambiarla y configurar la verificación en dos pasos en su primer acceso.',
      },
    };
  } catch (err) {
    return toState(err);
  }
}

export async function toggleOperatorAction(operatorId: string, disabled: boolean, _p: ActionState): Promise<ActionState> {
  try {
    const { actor } = await requireOperator('operators:manage');
    await setOperatorDisabled(operatorId, disabled, actor);
    revalidatePath('/operators');
    return { ok: disabled ? 'Operador deshabilitado.' : 'Operador habilitado.' };
  } catch (err) {
    return toState(err);
  }
}

export async function setRoleAction(operatorId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { actor } = await requireOperator('operators:manage');
    await setOperatorRole(operatorId, asRole(str(fd, 'role')), actor);
    revalidatePath('/operators');
    return { ok: 'Rol actualizado y sesiones cerradas.' };
  } catch (err) {
    return toState(err);
  }
}

export async function resetOperatorAction(operatorId: string, _p: ActionState): Promise<ActionState> {
  try {
    const { actor } = await requireOperator('operators:manage');
    const { temporaryPassword } = await resetOperatorCredentials(operatorId, actor);
    revalidatePath('/operators');
    return {
      ok: 'Credenciales reiniciadas y sesiones cerradas.',
      reveal: { title: 'Nueva contraseña temporal', lines: [temporaryPassword], note: 'Se muestra una sola vez.' },
    };
  } catch (err) {
    return toState(err);
  }
}
