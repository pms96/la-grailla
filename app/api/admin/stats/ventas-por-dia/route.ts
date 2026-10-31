export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { addDays, buildVentasPorDia, businessDayStart } from '@/lib/ventas-por-dia';
import { jornadaCorteHora } from '@/lib/jornada';
import { isModuleEnabled } from '@/lib/modules/runtime';

const dayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  from: dayParam.optional(),
  to: dayParam.optional(),
  eventId: z.string().min(1).optional(),
});

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const { from, to, eventId } = querySchema.parse({
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      eventId: searchParams.get('eventId') || undefined,
    });
    if (from && to && from > to) {
      return NextResponse.json({ error: 'La fecha "desde" no puede ser posterior a "hasta"' }, { status: 400 });
    }

    // Los días son JORNADAS de negocio en hora de Madrid (con la hora de corte configurada; 0 = día natural): "hasta" incluye la jornada completa. El
    // rango usa la misma definición que la agrupación (`businessDayStart` es la inversa de `businessDayKey`): filtro y días nunca discrepan.
    const corteHora = await jornadaCorteHora();
    const createdAt = {
      ...(from ? { gte: businessDayStart(from, corteHora) } : {}),
      ...(to ? { lt: businessDayStart(addDays(to, 1), corteHora) } : {}),
    };

    const [orders, ingresos] = await Promise.all([
      prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          ...(eventId ? { eventId } : {}),
          ...(from || to ? { createdAt } : {}),
        },
        select: {
          createdAt: true,
          totalAmount: true,
          channel: true,
          paymentMethod: true,
          _count: { select: { tickets: { where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } } } } },
        },
      }),
      // La caja manual no se registra por evento, así que con filtro de
      // evento no se compara. Ingreso.fecha es medianoche UTC del día elegido.
      // La caja manual es de Contabilidad: sin ese módulo no se lee, aunque queden ingresos de antes en la BD.
      eventId || !isModuleEnabled('contabilidad')
        ? Promise.resolve(null)
        : prisma.ingreso.findMany({
            where: {
              concepto: 'Entradas',
              ...(from || to
                ? {
                    fecha: {
                      ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
                      ...(to ? { lt: new Date(`${addDays(to, 1)}T00:00:00.000Z`) } : {}),
                    },
                  }
                : {}),
            },
            select: { fecha: true, concepto: true, importe: true },
          }),
    ]);

    const { dias, totales } = buildVentasPorDia(
      orders.map((o) => ({
        createdAt: o.createdAt,
        totalAmount: o.totalAmount,
        channel: o.channel,
        paymentMethod: o.paymentMethod,
        tickets: o._count.tickets,
      })),
      ingresos,
      { cutoffHour: corteHora }
    );

    return NextResponse.json({ dias, totales, cajaComparable: !eventId, corteHora });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/stats/ventas-por-dia');
  }
}
