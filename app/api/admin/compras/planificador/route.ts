export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { precioConIva, proveedorRecomendado, ahorroFrenteAlMasCaro } from '@/lib/compras/calculadora';

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

    // Referencia de consumo: la temporada anterior más reciente (por año), si existe.
    const temporadaAnterior = await prisma.temporada.findFirst({
      where: { anio: { lt: temporada.anio } },
      orderBy: { anio: 'desc' },
    });

    const [articulos, planes, consumos] = await Promise.all([
      prisma.articulo.findMany({
        where: { activo: true },
        orderBy: [{ categoria: 'asc' }, { nombre: 'asc' }],
        include: { precios: { include: { proveedor: true } } },
      }),
      prisma.planCompra.findMany({ where: { temporadaId } }),
      temporadaAnterior
        ? prisma.consumoHistorico.findMany({ where: { temporadaId: temporadaAnterior.id } })
        : Promise.resolve([]),
    ]);

    const planPorArticulo = new Map(planes.map((p) => [p.articuloId, p]));
    const consumoPorArticulo = new Map(consumos.map((c) => [c.articuloId, c]));

    const filas = articulos.map((articulo) => {
      const precios = articulo.precios
        .filter((p) => p.proveedor.activo)
        .map((p) => ({
          proveedorId: p.proveedorId,
          proveedorNombre: p.proveedor.nombre,
          precioSinIva: p.precioSinIva,
          precioConIva: precioConIva(p.precioSinIva, articulo.ivaPercent),
          formatoVenta: p.formatoVenta,
          unidadMinPedido: p.unidadMinPedido,
        }));

      const recomendado = proveedorRecomendado(precios);
      const ahorro = ahorroFrenteAlMasCaro(precios);
      const plan = planPorArticulo.get(articulo.id);
      const consumo = consumoPorArticulo.get(articulo.id);

      const proveedorElegidoId = plan?.proveedorElegidoId ?? recomendado?.proveedorId ?? null;
      const precioElegido = precios.find((p) => p.proveedorId === proveedorElegidoId) ?? null;
      const cantidadPlanificada = plan?.cantidadPlanificada ?? 0;

      return {
        articuloId: articulo.id,
        nombre: articulo.nombre,
        categoria: articulo.categoria,
        formato: articulo.formato,
        unidadesPorCaja: articulo.unidadesPorCaja,
        ivaPercent: articulo.ivaPercent,
        precios,
        recomendado,
        ahorroUnidad: ahorro,
        consumoReferencia: consumo ? { temporadaNombre: temporadaAnterior?.nombre ?? '', cantidadNeta: consumo.cantidadNeta } : null,
        proveedorElegidoId,
        cantidadPlanificada,
        observaciones: plan?.observaciones ?? '',
        costeTotalEstimado: precioElegido ? Math.round(precioElegido.precioConIva * cantidadPlanificada * 100) / 100 : 0,
      };
    });

    return NextResponse.json({ temporada, temporadaAnterior, filas });
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/compras/planificador');
  }
}
