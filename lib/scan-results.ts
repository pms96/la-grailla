/* Resultados de `ScanLog.result` que cuentan como ENTRADA al recinto (P1-06). Una admisión hecha a mano por el personal desde la búsqueda
 * (`VALID_MANUAL`) es una entrada igual que una lectura de QR (`VALID`): suma al aforo y a los ritmos de entrada. Se distingue en el registro, y
 * no hace falta una columna nueva porque `result` es texto libre. Todo lo que cuente entradas debe usar esta lista, no `'VALID'` suelto. */
export const ENTRY_RESULTS = ['VALID', 'VALID_MANUAL'] as const;

/** Reentrada autorizada por el ADMIN a quien ya entró y sale/vuelve a entrar (H-077). Ni es una entrada (no suma a «han entrado») ni un rechazo (no sube el % de rechazados). */
export const REENTRY_RESULT = 'REENTRY';

export function isEntryResult(result: string | null | undefined): boolean {
  return (ENTRY_RESULTS as readonly string[]).includes(result ?? '');
}
