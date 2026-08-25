export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

/**
 * El registro público de usuarios USER no está expuesto en la web (compra guest).
 * Las cuentas se crean desde /admin/usuarios. Esta ruta se mantiene cerrada
 * para no dejar una superficie de abuso.
 */
export async function POST() {
  return NextResponse.json({ error: 'Registro no disponible' }, { status: 404 });
}
