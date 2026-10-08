/* Restaura una copia del registro en una BD de control VACÍA (recién migrada).
 *
 *   REGISTRY_EXPORT_KEY=… npm run registry:import -- --in ./copias/registro-2026-10-09.json
 *
 * Después: `operator:create` para los operadores y `snapshots:refresh` para reconstruir el almacén replicado. */
import fs from 'node:fs';
import { prisma } from '../lib/db';
import { importRegistry } from '../lib/services/registry-export';

async function main() {
  const i = process.argv.indexOf('--in');
  const file = i >= 0 ? process.argv[i + 1] : undefined;
  if (!file) throw new Error('Falta --in <fichero>');
  const audit = await importRegistry(JSON.parse(fs.readFileSync(file, 'utf8')), prisma);
  console.log(`Registro restaurado (${audit} entradas de auditoría). Ahora: operator:create y snapshots:refresh.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
