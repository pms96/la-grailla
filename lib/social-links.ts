/* Redes sociales del cliente (Configuración → Redes sociales) para el pie de la web pública. */

export const SOCIAL_NETWORKS = [
  { key: 'social_instagram', label: 'Instagram' },
  { key: 'social_tiktok', label: 'TikTok' },
  { key: 'social_twitter', label: 'X' },
  { key: 'social_facebook', label: 'Facebook' },
] as const;

export const SOCIAL_KEYS: string[] = SOCIAL_NETWORKS.map((s) => s.key);

/** Solo enlaces http(s): lo escribe el cliente y va a un `href` (un `javascript:` no debe llegar nunca a la web pública). Sin esquema se asume https. */
export function safeHttpUrl(value: string | undefined | null): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Los enlaces a pintar: solo las redes con una dirección válida, en el orden de la lista. */
export function socialLinks(values: Record<string, string | undefined>): { label: string; href: string }[] {
  return SOCIAL_NETWORKS.flatMap((s) => {
    const href = safeHttpUrl(values[s.key]);
    return href ? [{ label: s.label, href }] : [];
  });
}
