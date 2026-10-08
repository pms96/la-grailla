import { escapeHtml } from '@/lib/html-escape';
import { absoluteBrandUrl, type Brand } from './brand';

// escapeHtml no toca las comillas: dentro de un atributo (src="…", alt="…") hay que escaparlas también.
const attr = (v: string) => escapeHtml(v).replace(/"/g, '&quot;');

/** Cabecera de marca para emails y páginas imprimibles: el logo (versión para fondo claro) o, sin logo, el nombre en el color de marca. */
export function brandLogoHtml(brand: Brand, baseUrl: string | undefined, height: number, extraStyle = ''): string {
  const src = absoluteBrandUrl(brand.logoOnLight ?? brand.logoOnDark, baseUrl);
  if (src) {
    return `<img src="${attr(src)}" alt="${attr(brand.name)}" height="${height}" style="height:${height}px;width:auto;${extraStyle}" />`;
  }
  return `<span style="display:inline-block;font-size:${Math.round(height * 0.7)}px;font-weight:bold;line-height:1;color:${brand.colors.emailAccent};${extraStyle}">${escapeHtml(brand.name)}</span>`;
}
