import type { PDFFont } from 'pdf-lib';

/**
 * Texto apto para una fuente estándar de pdf-lib (Helvetica solo codifica WinAnsi): `widthOfTextAtSize` y `drawText` LANZAN con un emoji, una «ł» o un salto de
 * línea, y la exportación completa respondía 500 (H-139). Aquí los saltos de línea y tabuladores pasan a espacio y lo que la fuente no codifica, a «?».
 * Se consulta el juego de caracteres de la propia fuente: lo que sí codifica (tildes, ñ, €, guiones largos, comillas tipográficas) se conserva tal cual.
 */
export function pdfText(font: PDFFont, text: string | null | undefined): string {
  if (!text) return '';
  const soportados = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of text.replace(/\s+/g, ' ')) {
    out += soportados.has(ch.codePointAt(0)!) ? ch : '?';
  }
  return out;
}
