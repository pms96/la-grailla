// Tipos de patrocinio (valor interno + etiqueta + precio) mostrados en el
// select del formulario público y en el alta manual de admin. Editables desde
// /admin/configuracion (pestaña "Sponsors"), guardados como JSON en
// AppConfig bajo la clave 'sponsor_tiers' (ver lib/config.ts). Este archivo
// no toca Prisma a propósito — lo importan tanto componentes de cliente como
// rutas de servidor, y así se mantiene seguro para el bundle del navegador.
// priceLabel es el texto libre que se muestra (ej. "30€", admite matices como
// "30€ + IVA"); priceAmount es el número real que se usa para calcular
// cuánto se registra como ingreso al marcar un sponsor como pagado (ver
// mark-paid/route.ts) — se mantienen separados a propósito para no tener que
// parsear priceLabel y arriesgarse a un importe mal interpretado.
export type SponsorTier = { value: string; label: string; priceLabel: string; priceAmount: number };

// Placeholders de fábrica — se usan mientras nadie haya guardado nada en
// Configuración, o si el JSON guardado quedara vacío/corrupto.
export const DEFAULT_SPONSOR_TIERS: SponsorTier[] = [
  { value: 'evento', label: 'Patrocinio de Evento', priceLabel: '30€', priceAmount: 30 },
  { value: 'espacio', label: 'Espacio físico / Stand', priceLabel: '50€', priceAmount: 50 },
  { value: 'ambos', label: 'Ambos', priceLabel: '75€', priceAmount: 75 },
];

// Para mostrar la etiqueta/precio elegidos junto al sponsorType guardado
// (SponsorRequest.sponsorType), que solo persiste el "valor interno" — el
// resto de datos del tipo puede haber cambiado o desaparecido desde
// Configuración, así que null es un resultado normal a tener en cuenta.
export function findSponsorTier(tiers: SponsorTier[], value: string | null | undefined): SponsorTier | null {
  if (!value) return null;
  return tiers.find((t) => t.value === value) ?? null;
}

export function parseSponsorTiers(raw: string | null | undefined): SponsorTier[] {
  if (!raw) return DEFAULT_SPONSOR_TIERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SPONSOR_TIERS;
    const valid = parsed
      .filter(
        (t): t is Omit<SponsorTier, 'priceAmount'> & { priceAmount?: unknown } =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as SponsorTier).value === 'string' &&
          (t as SponsorTier).value.trim().length > 0 &&
          typeof (t as SponsorTier).label === 'string' &&
          typeof (t as SponsorTier).priceLabel === 'string'
      )
      // priceAmount es nuevo — la configuración guardada antes de este cambio
      // no lo tiene, así que se rellena a 0 en vez de descartar el tipo entero.
      .map((t) => ({ ...t, priceAmount: typeof t.priceAmount === 'number' ? t.priceAmount : 0 }));
    return valid.length > 0 ? valid : DEFAULT_SPONSOR_TIERS;
  } catch {
    return DEFAULT_SPONSOR_TIERS;
  }
}
