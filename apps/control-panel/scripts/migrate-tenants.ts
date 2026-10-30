/* Aplica las migraciones del front a las BDs de los clientes (trabajo externo: nunca dentro del build ni de una petición).
 *
 *   npm run migrate:tenants -- [--dry-run] [--only <subId,subId>] [--canary <subId,subId>] \
 *                              [--concurrency 5] [--continue-on-failure] [--allow-destructive] [--no-republish] [--force-sales-window]
 *
 * Se niega a migrar un cliente con una venta en marcha (sala de espera con gente o ritmo de pedidos sostenido): queda sin lanzar y el
 * script sale con error. --force-sales-window lo salta.
 *
 * Para ante el primer fallo (los demás quedan SKIPPED). Con --dry-run solo lista lo pendiente y pasa el linter. */
import type { ActingOperator } from '../lib/actor';
import { prisma } from '../lib/db';
import { runMigrationsForAll } from '../lib/services/migrations';

const actor: ActingOperator = { id: 'cli', email: 'migraciones@servidor', role: 'SUPERADMIN', ip: null, userAgent: 'cli' };
const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const val = (n: string) => (has(n) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const list = (n: string) => (val(n) ? val(n)!.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function main() {
  const out = await runMigrationsForAll(actor, {
    dryRun: has('dry-run'),
    only: list('only'),
    canary: list('canary'),
    concurrency: val('concurrency') ? Number(val('concurrency')) : undefined,
    stopOnFailure: !has('continue-on-failure'),
    allowDestructive: has('allow-destructive'),
    republish: !has('no-republish'),
    // P1-22: con una venta en marcha el runner se niega a migrar a ese cliente. Solo con esta bandera se migra igualmente (queda en la auditoría).
    salesGuard: !has('force-sales-window'),
  });
  for (const r of out.results) {
    const tag = r.status === 'SUCCEEDED' ? '✓' : r.status === 'SKIPPED' ? '·' : '✗';
    const what = r.dryRun ? `pendientes: ${r.pending.length}` : `${r.fromVersion ?? '∅'} → ${r.toVersion ?? '∅'}`;
    console.log(`${tag} ${r.tenantId} ${r.status.padEnd(9)} ${what}${r.attempts > 1 ? ` (${r.attempts} intentos)` : ''}${r.error ? `\n    ${r.error.split('\n')[0]}` : ''}`);
    for (const w of r.warnings) console.log(`    aviso: ${w}`);
  }
  console.log(`\n${out.results.length} clientes · ${out.failed} fallidos · ${out.skipped} sin lanzar`);
  const heldBySales = out.results.filter((r) => r.blockedBySales);
  if (heldBySales.length) console.error(`\n${heldBySales.length} cliente(s) NO migrados porque tienen una venta en marcha: repite fuera de la venta (o con --force-sales-window si es imprescindible). Hasta entonces NO despliegues código que exija esa migración.`);
  const unsynced = out.results.filter((r) => r.republishFailed);
  if (unsynced.length) console.error(`\n${unsynced.length} cliente(s) migrados pero SIN republicar: pueden quedar en mantenimiento hasta publicar (npm run snapshots:refresh).`);
  if (out.failed || unsynced.length || heldBySales.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
