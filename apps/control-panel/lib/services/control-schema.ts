import { prisma } from '../db';

/* ¿Está la BD de control al día con lo que el panel desplegado espera? (lote 16, B). El build del panel NO migra su propia BD: se hace a mano o con el workflow «Migrar la BD de
 * control» de GitHub. Un panel desplegado con la BD atrasada falla en la primera consulta que toca lo nuevo (el inicio de sesión, por ejemplo), así que se avisa en pantalla y con el
 * latido del disparador. Es lo único que mira: NO migra nada. */

/** La última migración de `prisma/migrations` de este panel. Un test falla si hay una más reciente en disco: al añadir una migración, se actualiza aquí en el mismo cambio. */
export const EXPECTED_CONTROL_SCHEMA = '20261102120000_operator_login_buckets';

export type ControlSchemaState = 'ok' | 'behind' | 'unknown';
export type ControlSchemaStatus = { state: ControlSchemaState; applied: string | null; expected: string };

/** Puro. `unknown` = no hay nada que leer (no se afirma ni se niega). Una BD POR DELANTE del panel desplegado (otro despliegue más nuevo ya migró) no es un problema. */
export function compareControlSchema(applied: string | null, expected: string): ControlSchemaState {
  if (applied === null) return 'unknown';
  return applied >= expected ? 'ok' : 'behind';
}

const TTL_MS = 30_000;
let cache: { at: number; applied: string | null } | null = null;

/** Para los tests: olvida la lectura guardada. */
export function resetControlSchemaCache(): void {
  cache = null;
}

/**
 * Estado de la BD de control. Una consulta barata a `_prisma_migrations`, guardada 30 s (el layout la pide en cada petición). Nunca lanza: si no se puede leer, `unknown`, porque un aviso
 * no puede tumbar una página.
 */
export async function controlSchemaStatus(opts: { expected?: string; now?: number; fresh?: boolean } = {}): Promise<ControlSchemaStatus> {
  const expected = opts.expected ?? EXPECTED_CONTROL_SCHEMA;
  const now = opts.now ?? Date.now();
  if (opts.fresh || !cache || now - cache.at >= TTL_MS) {
    try {
      const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name DESC LIMIT 1`;
      cache = { at: now, applied: rows[0]?.migration_name ?? null };
    } catch {
      cache = { at: now, applied: null };
    }
  }
  return { state: compareControlSchema(cache.applied, expected), applied: cache.applied, expected };
}

/** El aviso que se enseña, o null. No nombra migraciones: el layout raíz se ve también antes de iniciar sesión. */
export function controlSchemaNotice(status: ControlSchemaStatus): { title: string; detail: string } | null {
  if (status.state !== 'behind') return null;
  return {
    title: 'Falta aplicar una migración a la base de datos del panel',
    detail:
      'El panel está por delante de su base de datos de control: hasta aplicarla, el inicio de sesión y algunas pantallas pueden fallar. Ejecuta en GitHub el workflow «Migrar la BD de control» con el modo «aplicar» (o `npm run db:migrate` dentro de apps/control-panel).',
  };
}
