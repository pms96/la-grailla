import { describe, it, expect, afterEach } from 'vitest';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rate-limit';

// El límite vive en Postgres (RateLimitBucket), no en un Map en memoria del
// proceso — esto es justo lo que hace que el límite sea real y compartido
// entre instancias serverless en vez de "N veces el límite configurado".
describe('rateLimit', () => {
  const scope = `test-scope-${Date.now()}`;

  afterEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: `${scope}:` } } });
  });

  it('permite hasta el límite y bloquea la siguiente petición', async () => {
    const identifier = 'ip-1';
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await rateLimit(scope, identifier, 5, 60_000));
    }

    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(results[5].ok).toBe(false);
    expect(results[5].retryAfter).toBeGreaterThan(0);
  });

  it('trata identificadores distintos como cubos independientes', async () => {
    for (let i = 0; i < 5; i++) {
      await rateLimit(scope, 'ip-a', 5, 60_000);
    }
    const blocked = await rateLimit(scope, 'ip-a', 5, 60_000);
    const otherIp = await rateLimit(scope, 'ip-b', 5, 60_000);

    expect(blocked.ok).toBe(false);
    expect(otherIp.ok).toBe(true);
  });

  it('reinicia el contador una vez pasada la ventana', async () => {
    // Ventana generosa (300ms) para que el tiempo de ida y vuelta a la base
    // de datos entre llamadas no la haga expirar por sí sola y vuelva el
    // test intermitente.
    const identifier = 'ip-window';
    const first = await rateLimit(scope, identifier, 1, 300);
    expect(first.ok).toBe(true);
    const blocked = await rateLimit(scope, identifier, 1, 300);
    expect(blocked.ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 350));

    const afterWindow = await rateLimit(scope, identifier, 1, 300);
    expect(afterWindow.ok).toBe(true);
  });

  it('no dobla el límite bajo peticiones concurrentes al mismo identificador', async () => {
    // El UPSERT atómico es lo que evita que dos peticiones simultáneas lean
    // "todavía no he llegado al límite" antes de que ninguna haya escrito —
    // el mismo tipo de condición de carrera que el resto del proyecto ya
    // cierra con locks de Postgres, aquí resuelta por el propio ON CONFLICT.
    const identifier = 'ip-concurrent';
    const responses = await Promise.all(Array.from({ length: 20 }, () => rateLimit(scope, identifier, 5, 60_000)));
    const allowed = responses.filter((r) => r.ok);
    expect(allowed.length).toBe(5);
  });
});
