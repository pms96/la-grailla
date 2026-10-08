/* Copia cifrada del registro (la BD de control) a un fichero.
 *
 *   REGISTRY_EXPORT_KEY=… npm run registry:export -- --out ./copias/registro-2026-10-09.json
 *
 * Guarda el fichero FUERA de la plataforma, y la clave REGISTRY_EXPORT_KEY (y SECRETS_KEYS) en otro sitio distinto. */
import fs from 'node:fs';
import { prisma } from '../lib/db';
import { exportRegistry } from '../lib/services/registry-export';

async function main() {
  const i = process.argv.indexOf('--out');
  const out = i >= 0 ? process.argv[i + 1] : undefined;
  if (!out) throw new Error('Falta --out <fichero>');
  if (fs.existsSync(out)) throw new Error(`${out} ya existe: no se sobrescribe`);
  const env = await exportRegistry();
  fs.writeFileSync(out, JSON.stringify(env), { mode: 0o600, flag: 'wx' });
  console.log(`Copia escrita en ${out} (${env.createdAt})`);
  for (const [k, n] of Object.entries(env.counts)) console.log(`  ${k.padEnd(20)} ${n}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
