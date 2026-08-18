import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

export function handleApiError(error: unknown, context: string): NextResponse {
  console.error(`[${context}]`, error);

  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'validation_error', details: error.flatten() },
      { status: 400 }
    );
  }

  return NextResponse.json({ error: 'internal_server_error' }, { status: 500 });
}
