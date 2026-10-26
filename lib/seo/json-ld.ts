/* Datos estructurados (Schema.org) para buscadores. Puro: sin servidor ni React. */

const LINE_SEPARATORS = new RegExp('[\\u2028\\u2029]', 'g');

/** Serializa JSON-LD para un <script>: escapa `<` (y los separadores de línea) para que un texto del cliente no pueda cerrar la etiqueta. */
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/** Dirección absoluta de una ruta o de una URL ya completa. `baseUrl` vacío = se deja tal cual. */
export function absoluteUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return baseUrl ? `${baseUrl}${url}` : url;
}
