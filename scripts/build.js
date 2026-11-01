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

// Tiempos de la conexión con la que migra el build (H-046). `lock_timeout`: si una migración no consigue el bloqueo de una tabla en 3 s (hay una venta en marcha),
// falla en lugar de esperar con las escrituras de esa tabla retenidas; el build no sigue y el despliegue no sale. `statement_timeout`: tope de una sentencia (5 min).
// Van como parámetros de arranque de la conexión (`options=-c …`), solo para ESTA conexión: no tocan la BD ni las conexiones normales de la app.
const LOCK_TIMEOUT_MS = 3000;
const STATEMENT_TIMEOUT_MS = 300000;

/** La URL con `lock_timeout` y `statement_timeout` en la conexión (pura). Una URL ilegible se devuelve tal cual. */
function withMigrationTimeouts(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const existing = u.searchParams.get('options');
  u.searchParams.delete('options');
  const mine = `-c lock_timeout=${LOCK_TIMEOUT_MS} -c statement_timeout=${STATEMENT_TIMEOUT_MS}`;
  const base = u.toString();
  // %20 y %3D: un «+» no se leería como espacio.
  return `${base}${base.includes('?') ? '&' : '?'}options=${encodeURIComponent(existing ? `${existing} ${mine}` : mine)}`;
}

/** El entorno del proceso de migración: `DIRECT_URL` (la conexión directa que Prisma usa para migrar) con los tiempos. `DATABASE_URL` (la de la app) no se toca. */
function migrationEnv(env) {
  return env.DIRECT_URL ? { ...env, DIRECT_URL: withMigrationTimeouts(env.DIRECT_URL) } : { ...env };
}

function run(label, command, args, env) {
  console.log(`\n[build] ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...(env ? { env } : {}) });
  if (result.error) {
    console.error(`[build] No se pudo ejecutar «${command}»: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/** La invocación de `prisma migrate deploy` del build: comando, argumentos y entorno (con los tiempos). Pura, para poder probarla. */
function migrateDeployInvocation(env) {
  return { label: 'prisma migrate deploy', command: 'npx', args: ['prisma', 'migrate', 'deploy'], env: migrationEnv(env) };
}

function main(env = process.env) {
  if (shouldMigrateOnBuild(env)) {
    console.log('[build] Se aplican las migraciones pendientes antes de compilar (prisma migrate deploy).');
    const inv = migrateDeployInvocation(env);
    const code = run(inv.label, inv.command, inv.args, inv.env);
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

module.exports = { shouldMigrateOnBuild, withMigrationTimeouts, migrationEnv, migrateDeployInvocation };

if (require.main === module) process.exit(main());
