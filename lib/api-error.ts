import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { captureOpsError, type OpsErrorContext } from '@/lib/observability/capture';

/**
 * `ops` (opcional) añade el contexto mínimo que ya se conoce en el punto de la llamada (proveedor, tipo, pedido) al aviso de Sentry; nunca datos
 * del comprador. Solo los fallos inesperados (el 500 del final) se avisan: un 400 de validación o un 409 los provoca el cliente y no son una incidencia.
 */
export function handleApiError(error: unknown, context: string, ops: Omit<OpsErrorContext, 'route'> = {}): NextResponse {
  console.error(`[${context}]`, error);

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
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
    return NextResponse.json(
      { error: 'No se puede eliminar: hay registros relacionados que dependen de este elemento.' },
      { status: 409 }
    );
  }

  captureOpsError(error, { route: context, ...ops });
  return NextResponse.json({ error: 'Ha ocurrido un error inesperado. Inténtalo de nuevo en unos segundos; si sigue pasando, avísanos.', code: 'internal_server_error' }, { status: 500 });
}
