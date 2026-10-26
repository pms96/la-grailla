import { getFallbackBaseUrl } from '@/lib/url';

/* URL canónica de una página pública: la del dominio del cliente, sin parámetros. Evita que el buscador trate como páginas distintas
 * `/tienda` y `/tienda?categoria=ropa`, o la ficha por id y por slug. Si no se conoce el dominio (desarrollo local sin NEXTAUTH_URL, o una
 * petición sin cliente) no se emite nada: una canónica a `localhost` sería peor que ninguna. */

/** Base pública de este sitio, sin barra final, o '' si no se puede saber. Nunca lanza. */
export function siteBaseUrl(): string {
  try {
    const base = getFallbackBaseUrl();
    if (!base) return '';
    new URL(base);
    return base.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** `{ alternates: { canonical } }` para el `Metadata` de una página, o `{}` si no hay dominio. `path` empieza por `/`. */
export function canonicalAlternates(path: string): { alternates?: { canonical: string } } {
  const base = siteBaseUrl();
  if (!base) return {};
  const clean = path.startsWith('/') ? path : `/${path}`;
  return { alternates: { canonical: clean === '/' ? `${base}/` : `${base}${clean.replace(/\/+$/, '')}` } };
}
