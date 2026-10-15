import { isLocalDatabaseUrl } from '../../scripts/is-local-database-url';

/* Guardia de la suite principal: los tests CREAN Y BORRAN datos (eventos, pedidos, usuarios, colas) en la base de datos a la que apunte el
 * entorno, y no hay mocks de Prisma. Con un `.env` apuntado por descuido a una base real (p. ej. la de La Grailla tras un pg_dump), un
 * `npm test` operaría sobre datos reales. Por eso la suite se niega a arrancar si esas URLs no son locales.
 *
 * Nunca se imprime la URL (es un secreto): solo el NOMBRE de la variable. Sin válvula de escape a propósito: si algún día hiciera falta
 * una base remota de pruebas, se decide aquí y se escribe, no se salta con una variable. */

const TEST_DB_VARS = ['DATABASE_URL', 'DIRECT_URL'] as const;

type Env = Record<string, string | undefined>;

/** Nombres de las variables de BD definidas que NO apuntan a una base local. Una variable sin definir no cuenta: la suite fallará por otro lado. */
export function nonLocalDatabaseVars(env: Env = process.env): string[] {
  return TEST_DB_VARS.filter((name) => {
    const value = env[name];
    return !!value && !isLocalDatabaseUrl(value);
  });
}

export function assertLocalTestDatabase(env: Env = process.env): void {
  const remote = nonLocalDatabaseVars(env);
  if (remote.length === 0) return;
  throw new Error(
    `Los tests se niegan a arrancar: ${remote.join(' y ')} no apunta${remote.length > 1 ? 'n' : ''} a una base de datos local (localhost o 127.0.0.1). ` +
      'Estos tests crean y borran datos; contra una base real los pisarían. ' +
      'Revisa el .env y las variables exportadas en la terminal (p. ej. tras un pg_dump) y usa la base de desarrollo local.'
  );
}
