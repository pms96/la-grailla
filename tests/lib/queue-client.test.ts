import { describe, it, expect } from 'vitest';
import { isBusyStatus, busyRetryMs, readJsonSafe, createTokenStore, countdownAnnouncement, remainingFrom } from '@/lib/queue-client';

// Lógica pura del cliente de la sala de espera (lote 2b). El componente (`waiting-room-gate.tsx`) solo la usa.

describe('isBusyStatus / busyRetryMs (H-090)', () => {
  it('429 y 5xx son «servicio ocupado» (esperado en un lanzamiento), no un fallo de red', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isBusyStatus(s), String(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 404]) expect(isBusyStatus(s), String(s)).toBe(false);
  });

  it('respeta Retry-After pero acotado a 2–30 s, con un poco de dispersión', () => {
    const zero = () => 0;
    const max = () => 0.999;
    expect(busyRetryMs(0, zero)).toBe(2000); // «ya mismo» no martillea la API
    expect(busyRetryMs(10, zero)).toBe(10_000);
    expect(busyRetryMs(10, max)).toBeGreaterThan(10_000);
    expect(busyRetryMs(10, max)).toBeLessThanOrEqual(11_000);
    expect(busyRetryMs(9999, zero)).toBe(30_000);
  });

  it('sin cabecera o ilegible usa 5 s', () => {
    expect(busyRetryMs(null, () => 0)).toBe(5000);
    expect(busyRetryMs(NaN, () => 0)).toBe(5000);
    expect(busyRetryMs(-3, () => 0)).toBe(5000);
  });
});

describe('readJsonSafe (H-090)', () => {
  it('devuelve el cuerpo JSON', async () => {
    expect(await readJsonSafe<{ a: number }>(new Response('{"a":1}'))).toEqual({ a: 1 });
  });
  it('un 502 con HTML no lanza: devuelve null (antes caía al «fallo de red» y se ignoraba Retry-After)', async () => {
    expect(await readJsonSafe(new Response('<html>Bad gateway</html>', { status: 502 }))).toBeNull();
  });
});

describe('createTokenStore (H-102)', () => {
  const memoryStorage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as unknown as Storage;
  };
  const blocked = () => ({
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  }) as unknown as Storage;

  it('guarda y lee del almacenamiento del navegador', () => {
    const s = memoryStorage();
    const store = createTokenStore(() => s);
    store.set('e1', 'tok');
    expect(store.get('e1')).toBe('tok');
    expect(s.getItem('queue_token_e1')).toBe('tok');
    store.remove('e1');
    expect(store.get('e1')).toBeNull();
  });

  it('con el almacenamiento bloqueado (modo privado, cookies off) no lanza y el turno vive en memoria', () => {
    const store = createTokenStore(() => blocked());
    expect(store.get('e1')).toBeNull();
    expect(() => store.set('e1', 'tok')).not.toThrow();
    expect(store.get('e1')).toBe('tok');
    store.remove('e1');
    expect(store.get('e1')).toBeNull();
  });

  it('si el propio acceso al almacenamiento lanza, también cae a memoria', () => {
    const store = createTokenStore(() => { throw new Error('denegado'); });
    store.set('e2', 'x');
    expect(store.get('e2')).toBe('x');
  });
});

describe('countdownAnnouncement (H-092)', () => {
  it('solo anuncia al cruzar 60 s y 10 s, no cada segundo', () => {
    expect(countdownAnnouncement(61, 60)).toMatch(/un minuto/i);
    expect(countdownAnnouncement(11, 10)).toMatch(/10 segundos/);
    expect(countdownAnnouncement(100, 99)).toBeNull();
    expect(countdownAnnouncement(45, 44)).toBeNull();
    expect(countdownAnnouncement(5, 4)).toBeNull();
  });
  it('si un salto se come el umbral (pestaña en segundo plano) igualmente lo anuncia una vez', () => {
    expect(countdownAnnouncement(75, 50)).toMatch(/un minuto/i);
  });
});

describe('remainingFrom (H-091)', () => {
  it('con el tiempo restante del servidor ignora el reloj del dispositivo', () => {
    // El dispositivo va 10 minutos adelantado: expiresAt (hora del servidor) parece ya pasado, pero el servidor dice que quedan 240 s.
    const skewedNow = Date.parse('2027-01-01T12:10:00Z');
    const expiresAt = '2027-01-01T12:04:00Z';
    expect(remainingFrom({ remainingMs: 240_000, expiresAt }, 1_000, 1_000, skewedNow)).toBe(240_000);
    expect(remainingFrom({ remainingMs: 240_000, expiresAt }, 1_000, 31_000, skewedNow)).toBe(210_000);
  });
  it('sin remainingMs (servidor anterior) cae a expiresAt y el reloj local', () => {
    const now = Date.parse('2027-01-01T12:00:00Z');
    expect(remainingFrom({ expiresAt: '2027-01-01T12:04:00Z' }, 0, 0, now)).toBe(240_000);
  });
});
