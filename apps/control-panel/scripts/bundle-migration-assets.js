/* Antes del build: mete en esta app lo que el botón «Migrar BD» necesita en tiempo de ejecución y que la función de Vercel no lleva sola.
 *
 *  1. `front-prisma/`: el `schema.prisma` y las migraciones del front (`../../prisma`).
 *  2. `migration-engine/modules/`: el CLI de Prisma y TODAS sus dependencias, en plano y fuera de `node_modules`. En Vercel el rastreo de
 *     archivos no llevaba `node_modules/prisma` a la función (el diagnóstico decía «no se encuentra el CLI de Prisma»), pero sí las carpetas
 *     de la propia app. El panel lo ejecuta con NODE_PATH apuntando aquí (ver lib/migrations/executor.ts).
 *
 * No se copian los motores de consulta (`libquery_engine*`, ~20 MB cada uno): el runner solo usa el motor de esquema. En local y en la CI
 * el panel sigue usando `../../prisma` y el `node_modules` de siempre; estas copias solo se usan si faltan. */
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.join(__dirname, '..');
const frontPrisma = path.join(appDir, '..', '..', 'prisma');
const outFront = path.join(appDir, 'front-prisma');
const outEngine = path.join(appDir, 'migration-engine');
const outModules = path.join(outEngine, 'modules');

// 1. Esquema y migraciones del front.
if (!fs.existsSync(path.join(frontPrisma, 'schema.prisma')) || !fs.existsSync(path.join(frontPrisma, 'migrations'))) {
  console.error(`bundle-migration-assets: no encuentro schema.prisma y migrations/ en ${frontPrisma}. En Vercel, activa «Include source files outside of the Root Directory».`);
  process.exit(1);
}
fs.rmSync(outFront, { recursive: true, force: true });
fs.mkdirSync(path.join(outFront, 'migrations'), { recursive: true });
fs.copyFileSync(path.join(frontPrisma, 'schema.prisma'), path.join(outFront, 'schema.prisma'));
fs.cpSync(path.join(frontPrisma, 'migrations'), path.join(outFront, 'migrations'), { recursive: true });
console.log(`bundle-migration-assets: ${fs.readdirSync(path.join(outFront, 'migrations')).length} entradas de migraciones copiadas a front-prisma/`);

// 2. CLI de Prisma y sus dependencias.
function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`No encuentro el paquete ${name} desde ${fromDir}`);
  }
}

const SKIP_FILE = /^libquery_engine|\.d\.ts$|\.map$/;
const seen = new Map();

function bundlePackage(name, fromDir) {
  const dir = findPackageDir(name, fromDir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (seen.has(name)) {
    if (seen.get(name) !== pkg.version) throw new Error(`${name}: se necesitan dos versiones (${seen.get(name)} y ${pkg.version}) y la copia en plano no lo admite`);
    return;
  }
  seen.set(name, pkg.version);
  fs.cpSync(dir, path.join(outModules, name), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      // Los `node_modules` anidados no se copian: sus paquetes se recorren como dependencias y quedan en plano. `build/public` es Prisma Studio.
      return base !== 'node_modules' && !SKIP_FILE.test(base) && !src.endsWith(path.join('build', 'public'));
    },
  });
  for (const dep of Object.keys(pkg.dependencies ?? {})) bundlePackage(dep, dir);
}

fs.rmSync(outEngine, { recursive: true, force: true });
fs.mkdirSync(outModules, { recursive: true });
bundlePackage('prisma', appDir);
console.log(`bundle-migration-assets: CLI de Prisma y ${seen.size - 1} dependencias copiados a migration-engine/modules/ (${[...seen.keys()].join(', ')})`);
