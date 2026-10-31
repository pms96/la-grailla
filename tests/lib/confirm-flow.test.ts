import { describe, it, expect } from 'vitest';
import { runConfirm } from '@/lib/confirm-flow';

/* H-011: el diálogo de anulación se cerraba aunque la petición fallase y se perdía el motivo escrito. */
describe('runConfirm: cuándo se cierra un diálogo de confirmación', () => {
  it('una acción que no devuelve nada (las de siempre) cierra', async () => {
    expect(await runConfirm(() => {})).toBe(true);
    expect(await runConfirm(async () => {})).toBe(true);
  });

  it('true cierra; false lo deja abierto (la petición falló y se conserva lo escrito)', async () => {
    expect(await runConfirm(async () => true)).toBe(true);
    expect(await runConfirm(async () => false)).toBe(false);
    expect(await runConfirm(() => false)).toBe(false);
  });

  it('una acción que lanza lo deja abierto y no propaga el error', async () => {
    expect(await runConfirm(async () => { throw new Error('red caída'); })).toBe(false);
    expect(await runConfirm(() => { throw new Error('boom'); })).toBe(false);
  });
});
