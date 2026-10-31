export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';
import { isOwnerAdmin } from '@/lib/access-roles';

/* Registro de acciones del personal (P1-16 / OB-12). Solo lectura y solo del propietario: ahí quedan los reembolsos, los cambios de pasarela y
 * de roles y las anulaciones, y un rol restringido no debe poder leer (ni, desde luego, escribir) su propio rastro.
 *
 * Filtros: `accion` (prefijo, p. ej. `gasto` o `order.refund`), `objetivo` (tipo, p. ej. `Gasto`), `id` (el objetivo concreto). Paginación por cursor
 * (`cursor` = id de la última fila vista). Más recientes primero. */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  if (!isOwnerAdmin(session)) return NextResponse.json({ error: 'Solo el propietario puede ver el registro de auditoría' }, { status: 403 });
  try {
    const { searchParams } = new URL(request.url);
    const accion = searchParams.get('accion')?.trim();
    const objetivo = searchParams.get('objetivo')?.trim();
    const id = searchParams.get('id')?.trim();
    const cursor = searchParams.get('cursor')?.trim();
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT));

    const rows = await prisma.adminAuditLog.findMany({
      where: {
        ...(accion ? { action: { startsWith: accion } } : {}),
        ...(objetivo ? { targetType: objetivo } : {}),
        ...(id ? { targetId: id } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return NextResponse.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/auditoria');
  }
}
