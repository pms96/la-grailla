/* Qué se enseña en la puerta cuando `/api/scan` NO responde con un veredicto (P1-06 / EN-12). Antes el cliente guardaba el cuerpo de un 429, un 401 o
 * un 500 tal cual: sin `message` ni `color`, la pantalla se quedaba en un ❌ sin fondo ni texto y el personal no sabía si era un QR falso o un
 * fallo del sistema. Aquí cada caso tiene su mensaje y su color, y un fallo del sistema NUNCA se parece a «entrada inválida» (rojo): es ámbar, para
 * que nadie rechace a un asistente con entrada válida por un corte. */

export interface DoorFailure {
  result: 'ERROR';
  message: string;
  color: 'yellow' | 'red';
}

/** `status`: código HTTP de la respuesta; `null` si ni siquiera hubo respuesta (sin red). */
export function doorFailure(status: number | null, serverMessage?: unknown): DoorFailure {
  if (status === null) {
    return { result: 'ERROR', message: 'SIN CONEXIÓN — No se ha podido validar. Comprueba la red y vuelve a escanear', color: 'yellow' };
  }
  if (status === 401) {
    return { result: 'ERROR', message: 'SESIÓN CADUCADA — Vuelve a entrar con tu usuario', color: 'yellow' };
  }
  if (status === 403) {
    return { result: 'ERROR', message: 'SIN PERMISO — Tu usuario no puede validar entradas', color: 'yellow' };
  }
  if (status === 429) {
    return { result: 'ERROR', message: 'DEMASIADOS ESCANEOS — Espera unos segundos y vuelve a escanear', color: 'yellow' };
  }
  if (status === 400 && typeof serverMessage === 'string' && serverMessage) {
    return { result: 'ERROR', message: serverMessage, color: 'yellow' };
  }
  return { result: 'ERROR', message: 'ERROR DEL SERVIDOR — No se ha validado. Reintenta en unos segundos', color: 'yellow' };
}

/** ¿El cuerpo es un veredicto del escáner (`result` + `message` + `color`) y no un error de transporte? */
export function isDoorVerdict(data: unknown): data is { result: string; message: string; color: string } {
  const d = data as { result?: unknown; message?: unknown; color?: unknown } | null;
  return !!d && typeof d.result === 'string' && typeof d.message === 'string' && typeof d.color === 'string';
}
