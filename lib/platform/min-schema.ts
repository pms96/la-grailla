/* Versión mínima de esquema que exige ESTE build del front (M7).
 *
 * Es la migración más nueva que el código de este build necesita en la BD de un cliente: nombre de carpeta de `prisma/migrations`.
 * En modo plataforma el middleware sirve «Cliente en mantenimiento» (503) a un cliente cuyo `schemaVersion` del registro sea
 * anterior (o desconocido), en lugar de dejar que cada lectura del modelo nuevo dé un 500. Cada cliente se migra con el runner de
 * migraciones del panel antes o justo después del despliegue y se levanta solo cuando el registro refleja la migración.
 *
 * SE SUBE A MANO, en el release que EMPIEZA a usar una columna o tabla nueva. Un release que no toca el esquema no la cambia.
 * Un test comprueba que la carpeta existe y que no es posterior a la última migración del repo.
 *
 * Archivo sin dependencias de Node: lo importa el middleware (edge). */
export const FRONT_MIN_SCHEMA = '20261015120000_access_roles';
