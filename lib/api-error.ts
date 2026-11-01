import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { captureOpsError, type OpsErrorContext } from '@/lib/observability/capture';
import { scrubString } from '@/lib/observability/scrub';
import { BodyTooLargeError } from '@/lib/http-body';

/**
 * El error como texto SEGURO para el log (H-111, H-130): tipo, código de Prisma y mensaje depurado (`scrubString` quita emails, teléfonos, ids de pago y los valores de una consulta de Prisma)
 * más las 6 primeras líneas de la pila (rutas y funciones, nada de código ni variables). `console.error(…, error)` imprimía el objeto entero y un error de Prisma lleva la consulta con
 * los datos del comprador; `scrubEvent` solo protegía Sentry, no el log de Vercel. Nunca lanza.
 */
export function errorForLog(error: unknown): string {
  try {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      const head = `${error.name}${typeof code === 'string' ? ` (${scrubString(code, 20)})` : ''}: ${scrubString(error.message, 500)}`;
      const frames = (error.stack ?? '')
        .split('\n')
        .filter((l) => /^\s+at /.test(l))
        .slice(0, 6)
        .map((l) => scrubString(l.trim(), 200));
      return [head, ...frames].join('\n    ');
    }
    return scrubString(String(error), 500);
  } catch {
    return '[error ilegible]';
  }
}

/**
 * `ops` (opcional) añade el contexto mínimo que ya se conoce en el punto de la llamada (proveedor, tipo, pedido) al aviso de Sentry; nunca datos
 * del comprador. Solo los fallos inesperados (el 500 del final) se avisan: un 400 de validación o un 409 los provoca el cliente y no son una incidencia.
 */
export function handleApiError(error: unknown, context: string, ops: Omit<OpsErrorContext, 'route'> = {}): NextResponse {
  console.error(`[${context}]`, errorForLog(error));

  // H-162: cuerpo por encima del tope de las rutas públicas (lib/http-body.ts). Lo provoca el cliente: ni Sentry ni 500.
  if (error instanceof BodyTooLargeError) {
    return NextResponse.json({ error: 'La petición es demasiado grande.', code: 'payload_too_large' }, { status: 413 });
  }

  // `error` es SIEMPRE un texto para la persona (en español): ~40 pantallas lo enseñan tal cual (H-084/H-010). El código técnico va aparte, en `code`.
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'Los datos enviados no son válidos. Revisa el formulario e inténtalo de nuevo.', code: 'validation_error', details: error.flatten() },
      { status: 400 }
    );
  }

  // P2003: violación de clave foránea — normalmente un DELETE sobre una fila
  // que todavía tiene registros relacionados (p.ej. borrar un Event con
  // Order/Ticket). Sin este mapeo caía en el 500 genérico de abajo; 409 deja
  // claro al cliente que el borrado no procede mientras existan esas
  // referencias, en vez de parecer un fallo interno inesperado.
  // H-130: solo un BORRADO (`.delete()` / `.deleteMany()`) es «no se puede eliminar»; una clave foránea rota al CREAR o ACTUALIZAR (un id que ya no existe) decía lo mismo y, además, no
  // llegaba a Sentry. Ahora ese caso es un 409 con otro texto Y se avisa: es un fallo del sistema, no algo que el usuario pidiera mal.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
    // Un borrado se reconoce por la operación del mensaje de Prisma o, si el mensaje no la trae, por el método de la ruta (`DELETE /api/…`).
    if (/\.(delete|deleteMany)\(\)/.test(error.message) || /^DELETE\b/i.test(context)) {
      return NextResponse.json({ error: 'No se puede eliminar: hay registros relacionados que dependen de este elemento.' }, { status: 409 });
    }
    captureOpsError(error, { route: context, ...ops });
    return NextResponse.json(
      { error: 'No se ha podido guardar porque un dato relacionado ya no existe. Recarga la página e inténtalo de nuevo.', code: 'related_record_missing' },
      { status: 409 }
    );
  }

  // P2002: violación de un UNIQUE que ninguna ruta atendió por su cuenta (un correo, un nombre repetido…). Es un conflicto del que pide, no una incidencia: 409 con texto
  // para la persona en lugar del 500 genérico (H-052).
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return NextResponse.json({ error: 'Ya existe un registro con ese valor. Cambia el dato repetido e inténtalo de nuevo.', code: 'already_exists' }, { status: 409 });
  }

  captureOpsError(error, { route: context, ...ops });
  return NextResponse.json({ error: 'Ha ocurrido un error inesperado. Inténtalo de nuevo en unos segundos; si sigue pasando, avísanos.', code: 'internal_server_error' }, { status: 500 });
}
