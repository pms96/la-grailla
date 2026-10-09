/* Claves de producción: se generan UNA vez, fuera del repositorio, y nunca se imprimen.
 *
 *   npm run keys:prod -- generate [--dir ~/grailla-produccion]   crea panel.env, platform.env y ops.env (0600; no sobrescribe)
 *   npm run keys:prod -- check    [--dir ~/grailla-produccion]   valida los tres ficheros ya rellenados (sale con 1 si algo falla)
 *
 * `generate` deja `__RELLENA__` donde va un dato de Neon o Upstash: los rellenas tú en el fichero. Después `check`.
 * Los ficheros panel.env y platform.env se pegan en Vercel («Import .env») solo en Production y como Sensitive. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { checkProdKeys, fingerprint, generateProdKeys, HEADERS, renderEnv, type ProdKeySet, type Vars } from '../lib/ops/prod-keys';

const argv = process.argv.slice(2);
const cmd = argv[0];
const dirArg = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : undefined;
const dir = path.resolve((dirArg ?? '~/grailla-produccion').replace(/^~(?=$|\/)/, os.homedir()));
const FILES = { panel: 'panel.env', platform: 'platform.env', ops: 'ops.env' } as const;
const REPO_ROOT = path.resolve(__dirname, '../../..');

function writeNew(file: string, text: string) {
  fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
}

async function generate() {
  const existing = Object.values(FILES).filter((f) => fs.existsSync(path.join(dir, f)));
  if (existing.length) throw new Error(`Ya existen ${existing.join(', ')} en ${dir}: no se sobrescriben (borrarlas por error te haría perder las claves de producción).`);
  const rel = path.relative(REPO_ROOT, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`${dir} está dentro del repositorio: usa una carpeta fuera (por defecto ~/grailla-produccion).`);
  const keys = await generateProdKeys();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const k of ['panel', 'platform', 'ops'] as const) writeNew(path.join(dir, FILES[k]), renderEnv(keys[k], HEADERS[k]));
  console.log(`Claves generadas en ${dir} (carpeta 0700, ficheros 0600). Ningún valor se ha mostrado.\n`);
  for (const k of ['panel', 'platform', 'ops'] as const) {
    console.log(FILES[k]);
    for (const [name, value] of Object.entries(keys[k])) console.log(`  ${name.padEnd(36)} ${value.includes('__RELLENA__') ? 'por rellenar' : `huella ${fingerprint(value)}`}`);
  }
  console.log('\nGUÁRDALOS ya en un gestor de contraseñas (los tres): perder SECRETS_KEYS es perder las URLs de BD de todos los clientes.');
  console.log('Cuando tengas los datos de Neon y Upstash, rellena los «__RELLENA__» y ejecuta: npm run keys:prod -- check');
}

function load(file: string): Vars {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) throw new Error(`Falta ${p}: ejecuta primero «generate».`);
  const mode = fs.statSync(p).mode & 0o777;
  if (mode & 0o077) console.warn(`Aviso: ${p} es legible por otros usuarios (permisos ${mode.toString(8)}): chmod 600 ${p}`);
  return parse(fs.readFileSync(p, 'utf8'));
}

async function check() {
  const set: ProdKeySet = { panel: load(FILES.panel), platform: load(FILES.platform), ops: load(FILES.ops) };
  const devEnv = path.resolve(__dirname, '../.env');
  const dev = fs.existsSync(devEnv) ? parse(fs.readFileSync(devEnv, 'utf8')) : {};
  const results = await checkProdKeys(set, dev);
  const icon = { pass: '✓', fail: '✗', warn: '!' } as const;
  for (const r of results) console.log(`${icon[r.status]} ${r.title}`);
  const bad = results.filter((r) => r.status === 'fail').length;
  console.log(bad ? `\n${bad} comprobaciones fallan: corrige los ficheros y repite.` : '\nTodo listo: ya puedes pegar panel.env y platform.env en Vercel (Production, Sensitive).');
  if (bad) process.exitCode = 1;
}

(cmd === 'generate' ? generate() : cmd === 'check' ? check() : Promise.reject(new Error('Uso: keys:prod <generate|check> [--dir carpeta]'))).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
