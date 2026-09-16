// Precios de referencia mostrados en el select del formulario público
// (app/(public)/sponsors/_components/sponsor-form.tsx) y en el alta manual de
// admin. ⚠️ Son placeholders — pendientes de confirmar los precios reales con
// el equipo antes de publicar el formulario con estos valores.
export type SponsorTier = { value: string; label: string; priceLabel: string };

export const SPONSOR_TIERS: SponsorTier[] = [
  { value: 'evento', label: 'Patrocinio de Evento', priceLabel: '30€' },
  { value: 'espacio', label: 'Espacio físico / Stand', priceLabel: '50€' },
  { value: 'ambos', label: 'Ambos', priceLabel: '75€' },
];
