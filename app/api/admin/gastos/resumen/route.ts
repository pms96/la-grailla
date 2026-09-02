export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { precioFinalUnidad, proveedorRecomendado, ahorroFrenteAlMasCaro } from '@/lib/compras/calculadora';

function precioConIvaTotal(importeSinIva: number, ivaPercent: number): number {
  return Math.round(importeSinIva * (1 + ivaPercent / 100) * 100) / 100;
}

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

    const temporadaAnterior = await prisma.temporada.findFirst({
      where: { anio: { lt: temporada.anio } },
      orderBy: { anio: 'desc' },
    });

    const [gastos, gastosAnterior, planes, eventosEnlazados] = await Promise.all([
      prisma.gasto.findMany({ where: { temporadaId } }),
      temporadaAnterior ? prisma.gasto.findMany({ where: { temporadaId: temporadaAnterior.id } }) : Promise.resolve([]),
      prisma.planCompra.findMany({
        where: { temporadaId, cantidadPlanificada: { gt: 0 } },
        include: { articulo: { include: { precios: { include: { proveedor: true } } } } },
      }),
      prisma.event.findMany({ where: { temporadaId }, select: { id: true } }),
    ]);

    const gastoTotal = Math.round(gastos.reduce((acc, g) => acc + precioConIvaTotal(g.importeSinIva, g.ivaPercent), 0) * 100) / 100;
    const gastoTotalAnterior = Math.round(gastosAnterior.reduce((acc, g) => acc + precioConIvaTotal(g.importeSinIva, g.ivaPercent), 0) * 100) / 100;

    // Ingresos reales de la temporada: solo se pueden calcular a partir de los eventos que el
    // admin ha enlazado explícitamente (Fase 2) — sin backfill ni adivinanza por fecha/nombre.
    const nEventosEnlazados = eventosEnlazados.length;
    const ingresosAgg = nEventosEnlazados
      ? await prisma.order.aggregate({
          where: { eventId: { in: eventosEnlazados.map((e) => e.id) }, status: 'COMPLETED' },
          _sum: { totalAmount: true },
        })
      : null;
    const ingresos = Math.round((ingresosAgg?._sum.totalAmount ?? 0) * 100) / 100;
    const margen = Math.round((ingresos - gastoTotal) * 100) / 100;

    const porCategoriaMap = new Map<string, number>();
    for (const g of gastos) {
      const actual = porCategoriaMap.get(g.categoria) ?? 0;
      porCategoriaMap.set(g.categoria, Math.round((actual + precioConIvaTotal(g.importeSinIva, g.ivaPercent)) * 100) / 100);
    }
    const porCategoria = Array.from(porCategoriaMap.entries()).map(([categoria, total]) => ({ categoria, total }));

    const porCategoriaAnteriorMap = new Map<string, number>();
    for (const g of gastosAnterior) {
      const actual = porCategoriaAnteriorMap.get(g.categoria) ?? 0;
      porCategoriaAnteriorMap.set(g.categoria, Math.round((actual + precioConIvaTotal(g.importeSinIva, g.ivaPercent)) * 100) / 100);
    }
    const categoriasComparadas = new Set([...porCategoriaMap.keys(), ...porCategoriaAnteriorMap.keys()]);
    const comparativoCategorias = Array.from(categoriasComparadas).map((categoria) => ({
      categoria,
      actual: porCategoriaMap.get(categoria) ?? 0,
      anterior: porCategoriaAnteriorMap.get(categoria) ?? 0,
    }));

    const topAhorro = planes
      .map((plan) => {
        const precios = plan.articulo.precios
          .filter((p) => p.proveedor.activo)
          .map((p) => ({
            proveedorId: p.proveedorId,
            proveedorNombre: p.proveedor.nombre,
            precioSinIva: p.precioSinIva,
            precioConIva: precioFinalUnidad(p.precioSinIva, p.descuentoPercent, plan.articulo.ivaPercent),
          }));
        const recomendado = proveedorRecomendado(precios);
        const ahorroUnidad = ahorroFrenteAlMasCaro(precios);
        return {
          articulo: plan.articulo.nombre,
          ahorroTotal: Math.round(ahorroUnidad * plan.cantidadPlanificada * 100) / 100,
          proveedorRecomendado: recomendado?.proveedorNombre ?? null,
        };
      })
      .filter((f) => f.ahorroTotal > 0)
      .sort((a, b) => b.ahorroTotal - a.ahorroTotal)
      .slice(0, 10);

    return NextResponse.json({
      temporada,
      temporadaAnterior,
      gastoTotal,
      gastoTotalAnterior,
      nGastos: gastos.length,
      porCategoria,
      comparativoCategorias,
      topAhorro,
      ingresos,
      margen,
      nEventosEnlazados,
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/gastos/resumen');
  }
}
