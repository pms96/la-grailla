/* Build de producción (M7): `prisma migrate deploy` (opcional) + `next build`.
 *
 * Por defecto migra en el build, como siempre (el proyecto actual de La Grailla sigue así). Se desactiva SIN tocar código con una variable
 * de entorno del proyecto, para poder pasar a migrar con el runner del panel (antes/después del despliegue, cliente a cliente):
 *   - SKIP_MIGRATE_ON_BUILD=1 (o true, yes, on…: cualquier valor salvo vacío, 0, false, no u off)
 *   - VERCEL_ENV=preview (las vistas previas nunca migran)
 *   - PLATFORM_MODE=on  (el proyecto `platform` no tiene una BD global: nunca migra en el build)
 * Volver atrás = quitar la variable. `next build` se ejecuta siempre. */
const { spawnSync } = require('node:child_process');

// SKIP_MIGRATE_ON_BUILD (H-127): estos valores NO saltan la migración; CUALQUIER otro valor sí. Antes solo valía exactamente «1»: `true`, `on` o `yes` (lo natural) seguían migrando la BD REAL.
// Ante la duda, no migrar: lo peor que pasa es que el front, sin migración, se queda en mantenimiento por la puerta de esquema; migrar a ciegas puede tocar una BD que no toca.
const MIGRATE_ON_VALUES = ['', '0', 'false', 'no', 'off'];
const skipFlag = (value) => !MIGRATE_ON_VALUES.includes(String(value ?? '').trim().toLowerCase());

/** ¿Hay que ejecutar `prisma migrate deploy` antes de `next build`? (pura, para poder probarla) */
function shouldMigrateOnBuild(env) {
  if (skipFlag(env.SKIP_MIGRATE_ON_BUILD)) return false;
  if (env.PLATFORM_MODE === 'on') return false;
  // Una vista previa (Preview) NUNCA migra: en el proyecto antiguo comparte variables con producción y, sin SKIP_MIGRATE_ON_BUILD, migraba la BD REAL por cada rama subida.
  if (env.VERCEL_ENV === 'preview') return false;
  return true;
}

/** Por qué no se migra (para el log del build). */
function skipReason(env) {
  if (env.PLATFORM_MODE === 'on') return 'PLATFORM_MODE=on';
  if (skipFlag(env.SKIP_MIGRATE_ON_BUILD)) return `SKIP_MIGRATE_ON_BUILD=${env.SKIP_MIGRATE_ON_BUILD}`;
  if (env.VERCEL_ENV === 'preview') return 'VERCEL_ENV=preview (las vistas previas nunca migran)';
  return 'motivo desconocido';
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
    console.log(`[build] No se migra en el build (${skipReason(env)}): las migraciones las aplica el runner antes o después del despliegue.`);
  }
  return run('next build', 'npx', ['next', 'build']);
}

module.exports = { shouldMigrateOnBuild, skipReason, withMigrationTimeouts, migrationEnv, migrateDeployInvocation };

if (require.main === module) process.exit(main());
