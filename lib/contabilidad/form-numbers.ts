/* Números tecleados en los formularios de Contabilidad (H-140). Antes cada formulario hacía `Number(texto) || 0`: un importe vacío se guardaba como un gasto de 0 €
 * y un IVA vacío como 0 % (el reverso del error de P1-17, que ponía 21 % por defecto), sin avisar. Aquí vacío o ilegible es `null` y el formulario lo dice.
 * Sin dependencias: lo usan componentes de cliente. */

/** Número de un campo de formulario («12,50» o «12.50»); `null` si está vacío o no es un número. Nunca 0 por defecto. */
export function parseFormNumber(raw: string | number | null | undefined): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim().replace(',', '.') : '';
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Tipo de IVA en %: de 0 a 100, o `null` si está vacío, no es un número o se sale del rango. El 0 solo sale si la persona lo ha escrito. */
export function parseIvaPercent(raw: string | number | null | undefined): number | null {
  const n = parseFormNumber(raw);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}
