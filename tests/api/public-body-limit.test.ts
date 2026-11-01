import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { MAX_PUBLIC_JSON_BYTES } from '@/lib/http-body';

const { POST: createOrder } = await import('@/app/api/orders/route');
const { POST: createShopOrder } = await import('@/app/api/shop/orders/route');

/* H-162: las dos rutas públicas de compra con arrays validados por zod 3 leen el cuerpo con tope (lib/http-body.ts) y responden 413 antes de validar. */

const IP = '198.51.100.162';
const request = (path: string, body: string) =>
  new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': IP }, body });

/** Un array enorme de elementos inválidos: lo que inflaría la memoria al validar. */
const hugeItems = (n: number) => JSON.stringify({ items: Array.from({ length: n }, () => ({})) });

const cleanup = () => prisma.rateLimitBucket.deleteMany({ where: { key: { contains: IP } } });

describe('H-162: tope de cuerpo en las compras públicas', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it.each([
    ['/api/orders', createOrder],
    ['/api/shop/orders', createShopOrder],
  ])('%s: un cuerpo por encima del tope da 413 sin validar', async (path, handler) => {
    const body = hugeItems(Math.ceil(MAX_PUBLIC_JSON_BYTES / 2));
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_PUBLIC_JSON_BYTES);
    const res = await handler(request(path, body));
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.code).toBe('payload_too_large');
    expect(typeof json.error).toBe('string');
  });

  it.each([
    ['/api/orders', createOrder],
    ['/api/shop/orders', createShopOrder],
  ])('%s: un cuerpo pequeño inválido sigue dando 400 de validación', async (path, handler) => {
    const res = await handler(request(path, JSON.stringify({ items: [] })));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('validation_error');
  });
});
