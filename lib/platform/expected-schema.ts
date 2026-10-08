import { FRONT_MIN_SCHEMA } from './min-schema';

/**
 * Última migración que CONOCE este build (la última carpeta de `prisma/migrations` al compilar). `next.config.js` la inyecta en
 * `FRONT_SCHEMA_EXPECTED`; si no está (un script o un test fuera de Next), se cae a la mínima exigida, que es la única que el código
 * garantiza conocer.
 */
export function expectedSchema(): string {
  return process.env.FRONT_SCHEMA_EXPECTED || FRONT_MIN_SCHEMA;
}
