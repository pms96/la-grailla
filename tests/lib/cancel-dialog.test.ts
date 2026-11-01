import { describe, expect, it } from 'vitest';
import { createDriveGuard, manualAdvice, manualWho } from '@/lib/cancel-dialog';

/* H-087: cerrar el diálogo con «sigue en segundo plano» y reabrir el mismo evento dejaba vivo el bucle viejo y permitía lanzar un segundo. H-089: «A resolver a mano» solo
 * mostraba los 8 primeros caracteres de un id y siempre decía «Ábrelo en Ventas para reembolsarlo», aunque el motivo fuera un aviso fallido. */

describe('createDriveGuard (H-087)', () => {
  it('un solo bucle vivo por evento: el segundo intento se rechaza', () => {
    const g = createDriveGuard();
    const t = g.begin('ev1');
    expect(t).not.toBeNull();
    expect(g.begin('ev1')).toBeNull();
    expect(g.begin('ev2')).not.toBeNull(); // otro evento, otro bucle
  });

  it('al terminar un bucle se puede empezar otro', () => {
    const g = createDriveGuard();
    const t = g.begin('ev1')!;
    g.end('ev1', t);
    expect(g.begin('ev1')).not.toBeNull();
  });

  it('cerrar la ventana invalida el bucle viejo aunque se reabra el MISMO evento: el viejo se corta y el nuevo manda', () => {
    const g = createDriveGuard();
    const old = g.begin('ev1')!;
    expect(g.valid('ev1', old)).toBe(true);
    g.cancelAll(); // se cierra (y la ventana sigue montada)
    expect(g.valid('ev1', old)).toBe(false); // el viejo ya no es vigente: se corta en su siguiente comprobación
    const fresh = g.begin('ev1'); // reabrir el mismo evento y continuar: sí puede empezar
    expect(fresh).not.toBeNull();
    expect(g.valid('ev1', fresh!)).toBe(true);
    expect(g.valid('ev1', old)).toBe(false);
  });

  it('el fin de un bucle invalidado no deja al nuevo sin guarda', () => {
    const g = createDriveGuard();
    const old = g.begin('ev1')!;
    g.cancelAll();
    const fresh = g.begin('ev1')!;
    g.end('ev1', old); // el viejo termina tarde: no debe borrar al nuevo
    expect(g.valid('ev1', fresh)).toBe(true);
    expect(g.begin('ev1')).toBeNull();
  });
});

describe('manualAdvice y manualWho (H-089)', () => {
  it('cada motivo tiene su consejo; solo el reembolso fallido o a medias manda a Ventas a reembolsar', () => {
    expect(manualAdvice('refund_failed')).toMatch(/Ventas.*reembols/i);
    expect(manualAdvice('half_refunded')).toMatch(/Ventas.*reembols/i);
    expect(manualAdvice('mail_failed')).toMatch(/avísale/i);
    expect(manualAdvice('mail_failed')).not.toMatch(/Ventas/);
    expect(manualAdvice('used')).toMatch(/Decide tú/);
  });

  it('dice a quién avisar: nombre, email e importe', () => {
    expect(manualWho({ buyerName: 'Ana Gil', buyerEmail: 'ana@example.com', amount: 20 })).toBe('Ana Gil · ana@example.com · 20,00 €');
  });

  it('sin importe o sin algún dato, no inventa nada', () => {
    expect(manualWho({ buyerName: '', buyerEmail: 'ana@example.com', amount: 0 })).toBe('ana@example.com');
    expect(manualWho({ buyerName: ' ', buyerEmail: ' ', amount: 0 })).toBe('');
  });
});
