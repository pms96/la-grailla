// Mensaje del aviso de edad mínima mostrado justo antes de comprar. El admin
// puede sobrescribirlo por evento (ageWarningMessage); si lo deja vacío, se
// genera uno por defecto a partir de la edad mínima ya configurada.
export function getEventAgeWarningMessage(event: {
  ageWarningEnabled: boolean;
  ageWarningMessage?: string | null;
  minAge?: number | null;
}): string | null {
  if (!event?.ageWarningEnabled) return null;
  const custom = event.ageWarningMessage?.trim();
  if (custom) return custom;
  const minAge = event.minAge ?? 18;
  return `No se permite la entrada a personas menores de ${minAge} años. Asegúrate de cumplir la edad mínima antes de comprar tu entrada — no se realizarán devoluciones por este motivo.`;
}
