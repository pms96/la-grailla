import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/observability/capture', () => ({ captureOpsError: capture }));

import { errorForLog, handleApiError } from '@/lib/api-error';

/* H-111 y H-130: `handleApiError` imprimía el error entero en el log de Vercel (un error de Prisma lleva la consulta con los datos del comprador; `scrubEvent` solo protegía Sentry) y
 * contaba como «No se puede eliminar…» una clave foránea rota al CREAR algo, sin avisar a Sentry. */

const prismaError = (message: string, code: string) => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
const WITH_VALUES = (op: string) =>
  `\nInvalid \`prisma.${op}()\` invocation:\n\n{\n  data: {\n    buyerName: "Ana María",\n    buyerEmail: "ana.maria@example.com",\n    buyerPhone: "+34 600 11 22 33"\n  }\n}\n\nForeign key constraint failed on the field: \`eventId\``;

let logged: unknown[][];
beforeEach(() => {
  capture.mockReset();
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
});
afterEach(() => vi.restoreAllMocks());
const everythingLogged = () => logged.map((a) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).join('\n');

describe('errorForLog (H-111)', () => {
  it('un error de Prisma con la consulta NO deja salir nombre, email ni teléfono del comprador, pero sí la operación y el motivo', () => {
    const text = errorForLog(prismaError(WITH_VALUES('order.create'), 'P2003'));
    expect(text).not.toMatch(/Ana María|ana\.maria|example\.com|600 11 22 33/);
    expect(text).toMatch(/P2003/);
    expect(text).toMatch(/order\.create/);
  });

  it('un error cualquiera: emails, teléfonos y claves de pasarela del mensaje salen redactados', () => {
    const text = errorForLog(new Error('fallo al avisar a ana@example.com (+34 600 11 22 33) con sk_live_abcdef1234567890'));
    expect(text).not.toMatch(/ana@example|600 11 22 33|sk_live_abcdef/);
    expect(text).toMatch(/^Error: /);
  });

  it('incluye como mucho 6 líneas de la pila (rutas y funciones), sin el mensaje repetido', () => {
    const e = new Error('x');
    e.stack = ['Error: x ana@example.com', ...Array.from({ length: 12 }, (_, i) => `    at fn${i} (/var/task/app/api/ruta${i}.js:${i}:1)`)].join('\n');
    const lines = errorForLog(e).split('\n');
    expect(lines).toHaveLength(7); // cabecera + 6 marcos
    expect(lines.join('\n')).not.toContain('ana@example');
  });

  it('lo que no es un Error (texto, objeto, null) también va redactado y nunca lanza', () => {
    expect(errorForLog('falló para ana@example.com')).not.toContain('ana@example');
    expect(errorForLog({ email: 'ana@example.com' })).not.toContain('ana@example');
    expect(errorForLog(null)).toBe('null');
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };
    expect(errorForLog(hostile)).toBe('[error ilegible]');
  });
});

describe('handleApiError: lo que se escribe en el log', () => {
  it('registra una línea de texto (no el objeto) y sin los datos del comprador', () => {
    handleApiError(prismaError(WITH_VALUES('order.create'), 'P2025'), 'POST /api/orders');
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe('[POST /api/orders]');
    expect(typeof logged[0][1]).toBe('string'); // antes: el objeto de error entero
    expect(everythingLogged()).not.toMatch(/Ana María|ana\.maria|example\.com|600 11 22 33/);
  });
});

describe('handleApiError: clave foránea (H-130)', () => {
  it('al BORRAR (delete / deleteMany): 409 «No se puede eliminar…» y sin aviso a Sentry (lo provoca quien pide)', async () => {
    for (const op of ['event.delete', 'order.deleteMany']) {
      const res = handleApiError(prismaError(WITH_VALUES(op), 'P2003'), 'POST /api/acciones'); // aunque la ruta no sea DELETE, el mensaje dice que era un borrado
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/No se puede eliminar/);
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it('al CREAR o ACTUALIZAR: 409 con otro texto y código, y SÍ se avisa (es un fallo del sistema, no «eliminar»)', async () => {
    for (const op of ['order.create', 'ticket.update', 'orderItem.createMany']) {
      capture.mockClear();
      const res = handleApiError(prismaError(WITH_VALUES(op), 'P2003'), 'POST /api/x', { provider: 'stripe' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).not.toMatch(/eliminar/i);
      expect(body.code).toBe('related_record_missing');
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0][1]).toMatchObject({ route: 'POST /api/x', provider: 'stripe' });
    }
  });

  it('un mensaje sin operación pero de una ruta DELETE sigue siendo «No se puede eliminar» y sin aviso', async () => {
    const res = handleApiError(prismaError('FK', 'P2003'), 'DELETE /api/admin/events/x');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/No se puede eliminar/);
    expect(capture).not.toHaveBeenCalled();
  });

  it('un mensaje sin operación reconocible se trata como NO-borrado (se avisa antes que callar)', async () => {
    const res = handleApiError(prismaError('Foreign key constraint failed', 'P2003'), 'POST /api/x');
    expect((await res.json()).code).toBe('related_record_missing');
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('handleApiError: el resto no cambia', () => {
  it('Zod → 400 con detalles; P2002 → 409 already_exists; lo demás → 500 y aviso', async () => {
    const zod = (() => {
      try {
        z.object({ a: z.string() }).parse({});
      } catch (e) {
        return e;
      }
    })();
    const bad = handleApiError(zod, 'x');
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('validation_error');
    const dup = handleApiError(prismaError('Unique constraint failed', 'P2002'), 'x');
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('already_exists');
    expect(capture).not.toHaveBeenCalled();
    const boom = handleApiError(new Error('boom'), 'x');
    expect(boom.status).toBe(500);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
