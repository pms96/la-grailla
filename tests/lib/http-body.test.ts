import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, MAX_PUBLIC_JSON_BYTES, readJsonLimited } from '@/lib/http-body';

/* H-162: zod 3 (aviso GHSA-mrhx-c7xc-m3w5) valida TODOS los elementos de un array antes de aplicar su `.max()`: un cuerpo de ~4 MB con millones de
 * elementos infla la memoria de la función. Las rutas públicas de compra leen el cuerpo con un tope antes de dárselo a zod. */

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

describe('readJsonLimited', () => {
  it('lee un JSON normal', async () => {
    expect(await readJsonLimited(post(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
  });

  it('acepta un cuerpo justo en el tope y rechaza uno un byte por encima', async () => {
    const pad = (n: number) => JSON.stringify({ x: 'a'.repeat(n - 8) });
    expect(Buffer.byteLength(pad(100))).toBe(100);
    await expect(readJsonLimited(post(pad(100)), 100)).resolves.toBeTruthy();
    await expect(readJsonLimited(post(pad(101)), 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('rechaza por la cabecera Content-Length sin leer el cuerpo', async () => {
    let pulled = false;
    // highWaterMark 0: sin él `new Request(stream)` ya lee por adelantado y no se distinguiría quién leyó.
    const stream = new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const req = new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'content-length': String(MAX_PUBLIC_JSON_BYTES + 1) },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    await expect(readJsonLimited(req)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled).toBe(false);
  });

  it('un Content-Length justo en el tope se acepta (no es «por encima»)', async () => {
    await expect(readJsonLimited(post('{}', { 'content-length': '100' }), 100)).resolves.toEqual({});
    await expect(readJsonLimited(post('{}', { 'content-length': '101' }), 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('corta un cuerpo sin Content-Length en cuanto pasa del tope (no lo lee entero) y cancela el flujo', async () => {
    let sent = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode('['.padEnd(1024, ' '));
    const stream = new ReadableStream(
      {
        pull(controller) {
          if (sent > 5000) return controller.close();
          sent += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    const req = new Request('http://localhost/api/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    await expect(readJsonLimited(req, 4096)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(sent).toBeLessThan(20);
    expect(cancelled).toBe(true);
  });

  it('un JSON inválido sigue lanzando SyntaxError, como request.json()', async () => {
    await expect(readJsonLimited(post('{no es json'))).rejects.toBeInstanceOf(SyntaxError);
  });

  it('un cuerpo vacío también lanza SyntaxError', async () => {
    await expect(readJsonLimited(post(''))).rejects.toBeInstanceOf(SyntaxError);
  });

  it('el tope es holgado para un pedido real (decenas de líneas) y estrecho para un ataque (megas)', () => {
    expect(MAX_PUBLIC_JSON_BYTES).toBeGreaterThanOrEqual(16 * 1024);
    expect(MAX_PUBLIC_JSON_BYTES).toBeLessThanOrEqual(128 * 1024);
  });
});
