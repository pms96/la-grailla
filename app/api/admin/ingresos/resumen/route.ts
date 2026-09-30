export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { importeGastoConIva } from '@/lib/gasto-calc';

// Balance = caja manual (Ingreso) de la temporada − Gasto de la misma
// temporada. A propósito NO incluye ventas de entradas online (Order) ni
// patrocinios pagados — eso ya se ve en /admin/estadisticas y en las cards
// de /admin/gastos; esta página es solo la caja física de la caseta.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const temporadaId = searchParams.get('temporadaId');
    if (!temporadaId) {
      return NextResponse.json({ error: 'Falta temporadaId' }, { status: 400 });
    }

    const temporada = await prisma.temporada.findUnique({ where: { id: temporadaId } });
    if (!temporada) {
      return NextResponse.json({ error: 'Temporada no encontrada' }, { status: 404 });
    }

    const [ingresos, gastos] = await Promise.all([
      prisma.ingreso.findMany({ where: { temporadaId }, orderBy: { fecha: 'asc' } }),
      prisma.gasto.findMany({ where: { temporadaId } }),
    ]);

    const ingresoTotal = Math.round(ingresos.reduce((acc, i) => acc + i.importe, 0) * 100) / 100;
    const gastoTotal = Math.round(gastos.reduce((acc, g) => acc + importeGastoConIva(g.importeSinIva, g.ivaPercent), 0) * 100) / 100;
    const balance = Math.round((ingresoTotal - gastoTotal) * 100) / 100;

    // Agrupado por día — cada "caja" que se cuenta al cerrar la jornada,
    // con sus líneas por concepto (entradas, barra, comida...).
    const porDiaMap = new Map<string, { fecha: string; total: number; lineas: { concepto: string; total: number }[] }>();
    for (const i of ingresos) {
      const dia = i.fecha.toISOString().slice(0, 10);
      const bucket = porDiaMap.get(dia) ?? { fecha: dia, total: 0, lineas: [] };
      bucket.total = Math.round((bucket.total + i.importe) * 100) / 100;
      const linea = bucket.lineas.find((l) => l.concepto === i.concepto);
      if (linea) {
        linea.total = Math.round((linea.total + i.importe) * 100) / 100;
      } else {
        bucket.lineas.push({ concepto: i.concepto, total: i.importe });
      }
      porDiaMap.set(dia, bucket);
    }
    const porDia = Array.from(porDiaMap.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));

    return NextResponse.json({
      temporada,
      ingresoTotal,
      gastoTotal,
      balance,
      nIngresos: ingresos.length,
      porDia,
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/ingresos/resumen');
  }
}
