import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export function handleApiError(error: unknown, context: string): NextResponse {
  console.error(`[${context}]`, error);

  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'validation_error', details: error.flatten() },
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

  return NextResponse.json({ error: 'internal_server_error' }, { status: 500 });
}
