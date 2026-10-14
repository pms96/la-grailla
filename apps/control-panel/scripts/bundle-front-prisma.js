/* Antes del build: copia el esquema y las migraciones del front (`../../prisma`) dentro de esta app (`front-prisma/`).
 *
 * El botón «Migrar BD» del panel aplica las migraciones del front a la BD de cada cliente y necesita leerlas en tiempo de ejecución. En Vercel
 * la función solo lleva los archivos de esta app (lo de fuera no entra en el rastreo), así que se meten dentro. Se copia lo justo: el
 * `schema.prisma` y las carpetas de migraciones, nada de semillas ni de otros ficheros. En local y en la CI el panel sigue leyendo
 * `../../prisma` directamente (ver `frontPrismaDir` en lib/services/migrations.ts); esta copia solo se usa si esa carpeta no existe. */
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', '..', '..', 'prisma');
const dst = path.join(__dirname, '..', 'front-prisma');

if (!fs.existsSync(path.join(src, 'schema.prisma')) || !fs.existsSync(path.join(src, 'migrations'))) {
  console.error(`bundle-front-prisma: no encuentro schema.prisma y migrations/ en ${src}. En Vercel, activa «Include source files outside of the Root Directory».`);
  process.exit(1);
}

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.join(dst, 'migrations'), { recursive: true });
fs.copyFileSync(path.join(src, 'schema.prisma'), path.join(dst, 'schema.prisma'));
fs.cpSync(path.join(src, 'migrations'), path.join(dst, 'migrations'), { recursive: true });
console.log(`bundle-front-prisma: ${fs.readdirSync(path.join(dst, 'migrations')).length} entradas copiadas a front-prisma/`);
