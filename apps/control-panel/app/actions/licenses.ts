'use server';

import { revalidatePath } from 'next/cache';
import { requireOperator } from '@/lib/guard';
import { createLicenseKey } from '@/lib/services/license';
import type { ActionState } from '../_components/action-form';
import { str, toState } from './util';

export async function createKeyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { actor } = await requireOperator('billing:write');
    const days = Number(str(fd, 'extendDays') || 0);
    const expires = Number(str(fd, 'expiresInDays') || 0);
    const { code } = await createLicenseKey(
      {
        modules: fd.getAll('modules').filter((v): v is string => typeof v === 'string'),
        extendDays: days,
        note: str(fd, 'note') || null,
        expiresInDays: expires > 0 ? expires : null,
      },
      actor
    );
    revalidatePath('/licenses');
    return { ok: 'Clave creada.', reveal: { title: 'Cópiala ahora', lines: [code], note: 'Solo se muestra esta vez: en el panel solo queda su huella.' } };
  } catch (err) {
    return toState(err);
  }
}
