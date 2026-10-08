export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { handleApiError } from '@/lib/api-error';

/* Bandeja de contacto (admin). Lista paginada con filtro por estado y búsqueda, más el recuento por estado para las pestañas. */

const STATUSES = ['NEW', 'ANSWERED', 'ARCHIVED'] as const;
const PAGE_SIZE = 30;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const status = STATUSES.find((s) => s === url.searchParams.get('status'));
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

    const where = {
      ...(status ? { status } : {}),
      ...(q
        ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }, { subject: { contains: q, mode: 'insensitive' as const } }, { message: { contains: q, mode: 'insensitive' as const } }] }
        : {}),
    };
    const [items, total, grouped] = await Promise.all([
      prisma.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: { id: true, name: true, email: true, subject: true, message: true, status: true, createdAt: true, _count: { select: { replies: true } } },
      }),
      prisma.contactMessage.count({ where }),
      prisma.contactMessage.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const counts: Record<string, number> = { NEW: 0, ANSWERED: 0, ARCHIVED: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;
    return NextResponse.json({
      items: items.map((m) => ({ ...m, message: m.message.slice(0, 160), replies: m._count.replies, _count: undefined })),
      total,
      page,
      pageSize: PAGE_SIZE,
      counts,
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/contact');
  }
}
