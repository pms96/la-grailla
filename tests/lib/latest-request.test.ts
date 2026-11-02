import { describe, expect, it } from 'vitest';
import { createLatest } from '@/lib/latest-request';

/* H-225: ninguna carga de gastos, ingresos, ventas ni estadísticas descartaba la respuesta vieja: con filtros que cambian rápido (o el buscador de ventas, con su debounce) una respuesta
 * lenta de la selección ANTERIOR llegaba la última y pisaba los datos de la actual (o, ahora, su error tapaba los datos buenos). Solo vale la respuesta de la última petición lanzada. */

describe('createLatest', () => {
  it('solo la última petición lanzada es la vigente', () => {
    const latest = createLatest();
    const a = latest.next();
    expect(latest.isCurrent(a)).toBe(true);
    const b = latest.next();
    expect(latest.isCurrent(a)).toBe(false);
    expect(latest.isCurrent(b)).toBe(true);
  });

  it('una respuesta vieja que llega tarde no pisa a la nueva (el patrón de las pantallas)', async () => {
    const latest = createLatest();
    let shown = '';
    const load = (label: string, delayMs: number) => {
      const id = latest.next();
      return new Promise<string>((resolve) => setTimeout(() => resolve(label), delayMs)).then((value) => {
        if (latest.isCurrent(id)) shown = value;
      });
    };
    await Promise.all([load('vieja (lenta)', 30), load('nueva (rápida)', 1)]);
    expect(shown).toBe('nueva (rápida)');
  });
});
