/* Texto de un error para enseñárselo a quien administra (H-165). Un `res.json()` sobre una respuesta que no es JSON (un 502 de HTML de un proxy caído) lanza un
 * SyntaxError con `Unexpected token '<', "<html>…" is not valid JSON`; un `fetch` sin red lanza `Failed to fetch`: textos en inglés, técnicos, que no dicen qué hacer. Lo que
 * escribimos nosotros (el `error` del servidor que se relanza con `new Error(data.error)`) se conserva; lo técnico se cambia por el texto de reserva de cada pantalla. */

const TECHNICAL = [
  /unexpected (?:token|end of|character)/i,
  /\bnot valid json\b/i,
  /json\.parse|json input|in json at position/i,
  /failed to fetch|networkerror|network request failed|load failed|fetch failed/i,
  /<\s*html|<!doctype/i,
  /^error$/i, // el genérico de `new Error(data?.error ?? 'Error')`: no dice nada
];

export function userMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message?.trim();
  if (!message || error instanceof SyntaxError) return fallback;
  return TECHNICAL.some((re) => re.test(message)) ? fallback : message;
}
