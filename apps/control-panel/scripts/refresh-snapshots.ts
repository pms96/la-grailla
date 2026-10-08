/* Vuelve a publicar todas las suscripciones ya publicadas (refresca `staleUntil` y avanza el calendario de licencia).
 * Debe ejecutarse a diario (cron/GitHub Actions): ver docs/platform/m5-cutover.md.
 *
 *   npm run snapshots:refresh */
import type { ActingOperator } from '../lib/actor';
import { prisma } from '../lib/db';
import { refreshAllSnapshots } from '../lib/services/license';

const actor: ActingOperator = { id: 'cli', email: 'refresco@servidor', role: 'SUPERADMIN', ip: null, userAgent: 'cli' };

refreshAllSnapshots(actor)
  .then(({ published, failed }) => {
    console.log(`Publicadas: ${published}. Fallidas: ${failed.length}`);
    for (const f of failed) console.error(`  ${f.subscriptionId}: ${f.error}`);
    if (failed.length) process.exitCode = 1;
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
