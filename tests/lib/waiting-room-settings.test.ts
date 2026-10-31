import { describe, it, expect } from 'vitest';
import { parseIntSetting, waitingRoomSettings, WAITING_ROOM_LIMITS } from '@/lib/waiting-room-settings';

// H-076: los ajustes de la sala de espera aceptaban 0 (nadie admitido / cada turno nacía caducado), texto (500) y decimales (500).

describe('waitingRoomSettings (lectura)', () => {
  it('usa los valores guardados cuando son válidos', () => {
    expect(waitingRoomSettings({ waitingRoomConcurrentSlots: 5, waitingRoomPurchaseWindowSeconds: 120 })).toEqual({ concurrentSlots: 5, windowSeconds: 120 });
  });

  it('sin valor guardado usa los de por defecto', () => {
    expect(waitingRoomSettings({ waitingRoomConcurrentSlots: null, waitingRoomPurchaseWindowSeconds: null })).toEqual({
      concurrentSlots: WAITING_ROOM_LIMITS.slots.default,
      windowSeconds: WAITING_ROOM_LIMITS.windowSeconds.default,
    });
  });

  it('un 0 ya guardado (antes se aceptaba) no deja la cola parada: cae al valor por defecto', () => {
    expect(waitingRoomSettings({ waitingRoomConcurrentSlots: 0, waitingRoomPurchaseWindowSeconds: 0 })).toEqual({
      concurrentSlots: WAITING_ROOM_LIMITS.slots.default,
      windowSeconds: WAITING_ROOM_LIMITS.windowSeconds.default,
    });
  });

  it('negativos, decimales y fuera de rango también caen al valor por defecto', () => {
    const out = waitingRoomSettings({ waitingRoomConcurrentSlots: -3, waitingRoomPurchaseWindowSeconds: 99_999 });
    expect(out.concurrentSlots).toBe(WAITING_ROOM_LIMITS.slots.default);
    expect(out.windowSeconds).toBe(WAITING_ROOM_LIMITS.windowSeconds.default);
    expect(waitingRoomSettings({ waitingRoomConcurrentSlots: 2.5, waitingRoomPurchaseWindowSeconds: 60.5 }).concurrentSlots).toBe(WAITING_ROOM_LIMITS.slots.default);
  });
});

describe('parseIntSetting (escritura)', () => {
  const slots = WAITING_ROOM_LIMITS.slots;

  it('vacío o nulo significa «sin valor» (se usará el de por defecto)', () => {
    expect(parseIntSetting('', slots)).toEqual({ ok: true, value: null });
    expect(parseIntSetting(null, slots)).toEqual({ ok: true, value: null });
  });

  it('undefined significa «no tocar»', () => {
    expect(parseIntSetting(undefined, slots)).toEqual({ ok: true, value: undefined });
  });

  it('acepta enteros en rango, también como texto', () => {
    expect(parseIntSetting(10, slots)).toEqual({ ok: true, value: 10 });
    expect(parseIntSetting('25', slots)).toEqual({ ok: true, value: 25 });
    expect(parseIntSetting(slots.min, slots)).toEqual({ ok: true, value: slots.min });
    expect(parseIntSetting(slots.max, slots)).toEqual({ ok: true, value: slots.max });
  });

  it('rechaza 0, negativos, decimales, texto y fuera de rango', () => {
    for (const bad of [0, -1, 1.5, 'abc', '1e3x', NaN, Infinity, slots.max + 1, '0']) {
      const out = parseIntSetting(bad, slots);
      expect(out.ok, String(bad)).toBe(false);
    }
  });
});
