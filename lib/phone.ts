// Normalización best-effort de teléfono — solo para poder construir enlaces
// wa.me después (lib/sponsor-portal.ts). No es una validación estricta: un
// campo opcional de un formulario de contacto no debe bloquear el envío por
// un formato de teléfono raro, así que si no parece un teléfono lo dejamos
// tal cual en vez de rechazarlo.
export function normalizePhone(raw: string | null | undefined, defaultCountryCode = '34'): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  const hasExplicitPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;

  if (hasExplicitPlus) return digits;
  // Sin "+": si ya trae pinta de llevar prefijo de país (más de 9 dígitos,
  // empieza distinto de los prefijos móviles/fijos españoles 6/7/8/9), lo
  // dejamos tal cual; si no, asumimos España.
  if (digits.length > 9) return digits;
  return `${defaultCountryCode}${digits}`;
}

export function buildWhatsAppLink(phone: string | null | undefined, text: string): string {
  const encoded = encodeURIComponent(text);
  const normalized = normalizePhone(phone);
  return normalized ? `https://wa.me/${normalized}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}
