import { describe, it, expect, vi } from 'vitest';

const create = vi.fn();
vi.mock('@/lib/prisma', () => ({ prisma: { adminAuditLog: { create: (...a: unknown[]) => create(...a) } } }));

const { sanitizeAuditMeta, diffFields, actorFromSession, recordAdminAudit, recordAdminAuditSafe } = await import('@/lib/admin-audit');

describe('sanitizeAuditMeta (P1-16 / OB-12): el registro nunca guarda secretos', () => {
  it('tapa las claves con pinta de secreto, también anidadas, y conserva el resto', () => {
    const out = sanitizeAuditMeta({
      motivo: 'duplicado',
      smtp_password: 'hunter2',
      apiKey: 'sk_live_123',
      nested: { token: 'abc', importe: 12 },
      hashedPassword: '$2a$12$xxxxxxxx',
    }) as Record<string, unknown>;
    expect(out.motivo).toBe('duplicado');
    expect(out.smtp_password).toBe('[redactado]');
    expect(out.apiKey).toBe('[redactado]');
    expect(out.hashedPassword).toBe('[redactado]');
    expect(out.nested).toEqual({ token: '[redactado]', importe: 12 });
    expect(JSON.stringify(out)).not.toMatch(/hunter2|sk_live_123|\$2a\$12/);
  });

  it('serializa fechas y Decimal como texto', () => {
    const decimal = { toFixed: () => '120.50', toString: () => '120.5' };
    const out = sanitizeAuditMeta({ fecha: new Date('2026-09-25T00:00:00.000Z'), importe: decimal }) as Record<string, unknown>;
    expect(out.fecha).toBe('2026-09-25T00:00:00.000Z');
    expect(out.importe).toBe('120.5');
  });

  it('recorta cadenas largas', () => {
    const long = sanitizeAuditMeta({ nota: 'x'.repeat(1000) }) as Record<string, string>;
    expect(long.nota.length).toBeLessThan(400);
  });

  // H-017: antes, pasar de 4000 caracteres tras serializar descartaba la meta ENTERA (también el importe anterior de una edición).
  it('si no cabe, acorta las cadenas antes de tirar nada: los importes y campos pequeños se conservan', () => {
    const notes = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`campo${i}`, `línea\n${'y'.repeat(300)}`]));
    const out = sanitizeAuditMeta({ importeAnterior: 120.5, importeNuevo: 99, ...notes }) as Record<string, unknown>;
    expect(out.importeAnterior).toBe(120.5);
    expect(out.importeNuevo).toBe(99);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4000);
    expect(out.truncated).toBeUndefined();
  });

  it('si ni acortando cabe, conserva las primeras claves y anota cuáles se dejaron fuera', () => {
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`campo${i}`, 'y'.repeat(300)]));
    const out = sanitizeAuditMeta({ importeAnterior: 120.5, ...many }) as { importeAnterior: number; campo0: string; truncated: boolean; keys: string[] };
    expect(out.importeAnterior).toBe(120.5);
    expect(out.campo0).toBeDefined();
    expect(out.truncated).toBe(true);
    expect(out.keys.length).toBeGreaterThan(0);
    expect(out.keys).not.toContain('importeAnterior');
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4000);
  });

  it('sin meta devuelve undefined', () => {
    expect(sanitizeAuditMeta(undefined)).toBeUndefined();
  });
});

describe('diffFields', () => {
  it('devuelve solo lo que cambia, comparando por texto', () => {
    const before = { concepto: 'Hielo', importeSinIva: '100', fecha: new Date('2026-09-25T00:00:00Z'), notas: null as string | null };
    const after = { concepto: 'Hielo', importeSinIva: '120', fecha: new Date('2026-09-25T00:00:00Z'), notas: '' as string | null };
    expect(diffFields(before, after, ['concepto', 'importeSinIva', 'fecha', 'notas'])).toEqual({ importeSinIva: { from: '100', to: '120' } });
  });
});

describe('recordAdminAudit', () => {
  it('escribe actor, acción, objetivo, IP (la de Vercel) y meta saneada', async () => {
    const db = { adminAuditLog: { create: vi.fn().mockResolvedValue({}) } };
    const request = new Request('http://localhost', { headers: { 'x-vercel-forwarded-for': '203.0.113.7' } });
    await recordAdminAudit(db, { id: 'u1', email: 'a@b.es' }, request, { action: 'gasto.void', targetType: 'Gasto', targetId: 'g1', meta: { motivo: 'error', password: 'x' } });
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: { actorId: 'u1', actorEmail: 'a@b.es', action: 'gasto.void', targetType: 'Gasto', targetId: 'g1', meta: { motivo: 'error', password: '[redactado]' }, ip: '203.0.113.7' },
    });
  });

  it('sin IP conocida guarda null, no la cadena «unknown»', async () => {
    const db = { adminAuditLog: { create: vi.fn().mockResolvedValue({}) } };
    await recordAdminAudit(db, {}, new Request('http://localhost'), { action: 'config.update', targetType: 'AppConfig' });
    expect(db.adminAuditLog.create.mock.calls[0][0].data.ip).toBeNull();
  });

  it('lanza si la escritura falla: dentro de una transacción debe deshacer el cambio', async () => {
    const db = { adminAuditLog: { create: vi.fn().mockRejectedValue(new Error('db caída')) } };
    await expect(recordAdminAudit(db, {}, undefined, { action: 'gasto.create', targetType: 'Gasto' })).rejects.toThrow('db caída');
  });
});

describe('recordAdminAuditSafe', () => {
  it('no lanza si falla y en el log solo deja el mensaje, no el objeto de error', async () => {
    // Sin vi.spyOn(console): se sustituye a mano y se restaura (el espía de vitest sobre console.error dejaba escapar el error de la promesa).
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => { calls.push(args); };
    create.mockImplementation(async () => {
      throw Object.assign(new Error('boom'), { meta: { email: 'comprador@example.com' } });
    });
    try {
      await expect(recordAdminAuditSafe({}, undefined, { action: 'order.refund', targetType: 'Order', targetId: 'o1' })).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(calls).toEqual([['[audit] no se pudo registrar order.refund:', 'boom']]);
  });
});

describe('actorFromSession', () => {
  it('toma id y email; sin sesión, nulos', () => {
    expect(actorFromSession({ user: { id: 'u1', email: 'a@b.es' } })).toEqual({ id: 'u1', email: 'a@b.es' });
    expect(actorFromSession(null)).toEqual({ id: null, email: null });
  });
});
