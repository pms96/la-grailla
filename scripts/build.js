/* Build de producción (M7): `prisma migrate deploy` (opcional) + `next build`.
 *
 * Por defecto migra en el build, como siempre (el proyecto actual de La Grailla sigue así). Se desactiva SIN tocar código con una variable
 * de entorno del proyecto, para poder pasar a migrar con el runner del panel (antes/después del despliegue, cliente a cliente):
 *   - SKIP_MIGRATE_ON_BUILD=1
 *   - PLATFORM_MODE=on  (el proyecto `platform` no tiene una BD global: nunca migra en el build)
 * Volver atrás = quitar la variable. `next build` se ejecuta siempre. */
const { spawnSync } = require('node:child_process');

/** ¿Hay que ejecutar `prisma migrate deploy` antes de `next build`? (pura, para poder probarla) */
function shouldMigrateOnBuild(env) {
  if (env.SKIP_MIGRATE_ON_BUILD === '1') return false;
  if (env.PLATFORM_MODE === 'on') return false;
  return true;
}

function run(label, command, args) {
  console.log(`\n[build] ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(`[build] No se pudo ejecutar «${command}»: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function main(env = process.env) {
  if (shouldMigrateOnBuild(env)) {
    console.log('[build] Se aplican las migraciones pendientes antes de compilar (prisma migrate deploy).');
    const code = run('prisma migrate deploy', 'npx', ['prisma', 'migrate', 'deploy']);
    if (code !== 0) {
      console.error('[build] Falló prisma migrate deploy: no se compila.');
      return code;
    }
  } else {
    const why = env.PLATFORM_MODE === 'on' ? 'PLATFORM_MODE=on' : 'SKIP_MIGRATE_ON_BUILD=1';
    console.log(`[build] No se migra en el build (${why}): las migraciones las aplica el runner antes o después del despliegue.`);
  }
  return run('next build', 'npx', ['next', 'build']);
}

module.exports = { shouldMigrateOnBuild };

if (require.main === module) process.exit(main());
