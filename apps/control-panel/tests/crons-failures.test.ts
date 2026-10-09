import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';
import { prisma } from '@/lib/db';
import { dispatchHttpStatus, dispatchTenantJobs } from '@/lib/services/crons';
import { verifyDomainManually } from '@/lib/services/domains';
import { publishSubscription } from '@/lib/services/snapshot';
import { freshStore, makeOperator, resetControlDb, rootCreateTenant } from './helpers';

// La salud guarda su resultado en la BD de control: se sustituye solo `recordHealth` para simular que esa BD falla.
vi.mock('@/lib/services/health', async (original) => ({ ...(await original<typeof import('@/lib/services/health')>()), recordHealth: vi.fn() }));
import { recordHealth } from '@/lib/services/health';

process.env.PLATFORM_CRON_MASTER = generateMasterKey();
process.env.TENANT_URL_TEMPLATE = 'http://{host}:9999';

async function publishedTenant() {
  const { actor } = await makeOperator('SUPERADMIN');
  const { subscription, domain } = await rootCreateTenant();
  await verifyDomainManually(domain.id, actor);
  await publishSubscription(subscription.id, actor, freshStore());
  return { subscription, host: domain.host };
}

const okFetch = async () => new Response('{}', { status: 200 });

beforeEach(async () => {
  await resetControlDb();
  vi.mocked(recordHealth).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('dispatchHttpStatus', () => {
  it('200 si nada falló y todo lo vencido se lanzó (o si no había nada)', () => {
    expect(dispatchHttpStatus({ due: 0, ran: 0, failed: 0 })).toBe(200);
    expect(dispatchHttpStatus({ due: 4, ran: 4, failed: 0 })).toBe(200);
    expect(dispatchHttpStatus({ due: 9, ran: 4, failed: 0 })).toBe(200); // lo que no cupo espera a la siguiente, con progreso
  });

  it('500 si alguna tarea falló', () => {
    expect(dispatchHttpStatus({ due: 4, ran: 4, failed: 1 })).toBe(500);
  });

  it('500 si había tareas vencidas y no se pudo lanzar ninguna', () => {
    expect(dispatchHttpStatus({ due: 3, ran: 0, failed: 0 })).toBe(500);
  });
});

describe('un fallo inesperado de un cliente no aborta la pasada de los demás', () => {
  it('si guardar la salud falla (BD de control), ese cliente cuenta como fallido, queda anotado y los otros siguen', async () => {
    const a = await publishedTenant();
    const b = await publishedTenant();
    vi.mocked(recordHealth).mockRejectedValueOnce(new Error('BD de control caída'));

    const summary = await dispatchTenantJobs({ jobs: ['health'], fetchImpl: okFetch });

    expect(summary).toMatchObject({ due: 2, ran: 2, failed: 2 }); // el cuerpo `{}` tampoco es una salud válida: lo importante es que ran=2
    const states = await prisma.cronState.findMany({ where: { job: 'health' } });
    expect(states).toHaveLength(2);
    const broken = states.find((s) => s.lastError?.includes('Error interno del disparador'));
    expect(broken?.lastError).toContain('BD de control caída');
    expect(broken?.consecutiveFailures).toBe(1);
    expect(new Set(states.map((s) => s.subscriptionId))).toEqual(new Set([a.subscription.id, b.subscription.id]));
  });

  it('si anotar el estado falla, la pasada sigue y la fila queda vencida para reintentarla', async () => {
    await publishedTenant();
    await publishedTenant();
    const update = vi.spyOn(prisma.cronState, 'update').mockRejectedValueOnce(new Error('sin conexión'));

    const summary = await dispatchTenantJobs({ jobs: ['reconcile-payments'], fetchImpl: okFetch });
    update.mockRestore();

    expect(summary).toMatchObject({ due: 2, ran: 2, ok: 2 });
    const pending = await prisma.cronState.findMany({ where: { job: 'reconcile-payments', lastRunAt: null } });
    expect(pending).toHaveLength(1);
    const lines = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('no se pudo anotar el estado'))).toBe(true);
  });
});
