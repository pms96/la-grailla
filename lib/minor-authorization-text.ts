// Cuerpo legal por defecto de la autorización de menores (16-17 años). No
// incluye "ENTREGAR EN TAQUILLA" ni la línea de fecha/lugar/firma — esas se
// dibujan siempre como parte fija del PDF (ver lib/minor-authorization-pdf.ts)
// para que el admin no pueda borrarlas sin querer al editar el párrafo legal.
/** `organizer` es cómo se nombra a quien organiza el evento dentro del texto (Brand.organizer: p. ej. `la caseta "LA GRAILLA"` o `"SALA NORTE"`). */
export const defaultMinorAuthorizationText = (organizer: string): string => `Mediante la firma del presente formulario, el progenitor/tutor autoriza a ${organizer} a permitir el acceso y la permanencia del menor arriba identificado en el recinto durante el horario del evento, asumiendo la responsabilidad y custodia del menor durante su asistencia. La organización podrá denegar el acceso o solicitar la salida del recinto a cualquier menor que incumpla las normas de convivencia o cuyo comportamiento suponga un riesgo, sin derecho a devolución del importe de la entrada. Los datos personales facilitados en este formulario se tratarán conforme a la normativa de protección de datos vigente, con la única finalidad de gestionar el acceso del menor al evento.`;

/** Texto por defecto de La Grailla (se conserva para quien lo importe); el resto de clientes usan `defaultMinorAuthorizationText(brand.organizer)`. */
export const DEFAULT_MINOR_AUTHORIZATION_TEXT = defaultMinorAuthorizationText('la caseta "LA GRAILLA"');

export function resolveMinorAuthorizationText(event: { minorAuthorizationText?: string | null }, organizer?: string): string {
  if (event.minorAuthorizationText?.trim()) return event.minorAuthorizationText;
  return organizer ? defaultMinorAuthorizationText(organizer) : DEFAULT_MINOR_AUTHORIZATION_TEXT;
}
