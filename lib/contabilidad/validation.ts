import { z } from 'zod';

/* Validación de lo que escribe Contabilidad (H-055, H-140). Antes `fecha` era `z.string()` sin más: un texto con hora u offset se guardaba como un instante
 * que NO es medianoche UTC (los agrupadores por prefijo `YYYY-MM-DD` rompen el día) y «abc» daba 500; `coerce.number()` convertía un campo vacío en 0 (un gasto
 * de 0 € o un IVA del 0 % sin avisar) y el IVA no tenía rango (un «210» por «21,0» triplicaba el gasto). */

/** Tope de `Decimal(10,2)`: más allá la BD falla con un 500 en lugar de un aviso claro. */
export const MAX_IMPORTE = 99_999_999.99;

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIA_ISO_MEDIANOCHE = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.000)?Z$/;

/**
 * Día contable como medianoche UTC (el formato de las demás filas). Acepta `YYYY-MM-DD` y el ISO a medianoche UTC que devuelve la propia API al editar
 * una fila; rechaza cualquier otra cosa (con hora, con offset, texto) y los días que no existen (30 de febrero). Pura.
 */
export function parseFechaDia(raw: string): Date | null {
  const m = DIA.exec(raw.trim()) ?? DIA_ISO_MEDIANOCHE.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/** Fecha de un apunte: texto válido según `parseFechaDia`. La salida sigue siendo el texto; conviértelo con `parseFechaDia`. */
export const fechaDiaSchema = z.string().refine((v) => parseFechaDia(v) !== null, { message: 'fecha_invalida' });

/** Un campo vacío, nulo o no numérico es un error, no un 0 silencioso (`coerce.number()` convertía '' y null en 0). */
const blankToNaN = (v: unknown) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? Number.NaN : v);

/** Importe en euros: finito, dentro de lo que cabe en la columna. Admite negativos (abonos); neutralizar importes es un límite documentado (H-024). */
export const importeSchema = z.preprocess(blankToNaN, z.coerce.number().finite().min(-MAX_IMPORTE).max(MAX_IMPORTE));

/** Tipo de IVA en %: de 0 a 100. */
export const ivaPercentSchema = z.preprocess(blankToNaN, z.coerce.number().finite().min(0).max(100));

/** Precio de un artículo de Compras (H-233): como `importeSchema` pero sin negativos (un precio no es un abono). Vacío o nulo no es 0. */
export const precioSchema = z.preprocess(blankToNaN, z.coerce.number().finite().min(0).max(MAX_IMPORTE));

/** Cantidad planificada de Compras (H-233): finita, de 0 a un millón de unidades; vacío o nulo no es 0. */
export const cantidadSchema = z.preprocess(blankToNaN, z.coerce.number().finite().min(0).max(1_000_000));
