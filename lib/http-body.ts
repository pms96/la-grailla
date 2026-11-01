/**
 * Lectura de un cuerpo JSON con tope de tamaño (H-162).
 *
 * zod 3 valida TODOS los elementos de un array antes de aplicar su `.max()` y apunta un aviso por cada uno que falla (GHSA-mrhx-c7xc-m3w5): un cuerpo de
 * unos MB de `[{},{},…]` hacía que una ruta pública sin sesión reservara cientos de MB. La corrección de verdad es zod 4 (cambio mayor que afecta también al
 * panel y a los contratos); mientras tanto las rutas públicas con arrays leen el cuerpo con este tope, antes de dárselo a zod.
 */

/** Un pedido real son unas decenas de líneas (cientos de bytes); 32 KB deja un margen muy amplio y deja fuera cualquier ataque de megas. */
export const MAX_PUBLIC_JSON_BYTES = 32 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super('Cuerpo de la petición demasiado grande');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Igual que `request.json()` (lanza `SyntaxError` ante un JSON inválido o vacío) pero lanza `BodyTooLargeError` si el cuerpo supera `maxBytes`.
 * Primero mira `Content-Length` (sin leer nada) y, como un cliente puede no enviarlo o mentir, cuenta los bytes del flujo y lo corta al pasarse.
 */
export async function readJsonLimited(request: Request, maxBytes: number = MAX_PUBLIC_JSON_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();

  const reader = request.body?.getReader();
  if (!reader) return JSON.parse('');

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
