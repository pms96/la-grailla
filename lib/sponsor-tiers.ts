// Tipos de patrocinio (valor interno + etiqueta + precio) mostrados en el
// select del formulario público y en el alta manual de admin. Editables desde
// /admin/configuracion (pestaña "Sponsors"), guardados como JSON en
// AppConfig bajo la clave 'sponsor_tiers' (ver lib/config.ts). Este archivo
// no toca Prisma a propósito — lo importan tanto componentes de cliente como
// rutas de servidor, y así se mantiene seguro para el bundle del navegador.
export type SponsorTier = { value: string; label: string; priceLabel: string };

// Placeholders de fábrica — se usan mientras nadie haya guardado nada en
// Configuración, o si el JSON guardado quedara vacío/corrupto.
export const DEFAULT_SPONSOR_TIERS: SponsorTier[] = [
  { value: 'evento', label: 'Patrocinio de Evento', priceLabel: '30€' },
  { value: 'espacio', label: 'Espacio físico / Stand', priceLabel: '50€' },
  { value: 'ambos', label: 'Ambos', priceLabel: '75€' },
];

export function parseSponsorTiers(raw: string | null | undefined): SponsorTier[] {
  if (!raw) return DEFAULT_SPONSOR_TIERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SPONSOR_TIERS;
    const valid = parsed.filter(
      (t): t is SponsorTier =>
        !!t &&
        typeof t === 'object' &&
        typeof (t as SponsorTier).value === 'string' &&
        (t as SponsorTier).value.trim().length > 0 &&
        typeof (t as SponsorTier).label === 'string' &&
        typeof (t as SponsorTier).priceLabel === 'string'
    );
    return valid.length > 0 ? valid : DEFAULT_SPONSOR_TIERS;
  } catch {
    return DEFAULT_SPONSOR_TIERS;
  }
}
