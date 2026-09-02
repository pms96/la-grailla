import { prisma } from '@/lib/prisma';
import { precioFinalUnidad, proveedorRecomendado, ahorroFrenteAlMasCaro } from '@/lib/compras/calculadora';

export type FilaPlanificador = {
  articuloId: string;
  nombre: string;
  categoria: string;
  formato: string;
  unidadesPorCaja: number;
  ivaPercent: number;
  precios: {
    proveedorId: string;
    proveedorNombre: string;
    precioSinIva: number;
    descuentoPercent: number;
    precioConIva: number;
    formatoVenta: string;
    unidadMinPedido: number;
  }[];
  recomendado: { proveedorId: string; proveedorNombre: string; precioConIva: number } | null;
  ahorroUnidad: number;
  // Ahorro total frente al proveedor más caro si se compra toda la cantidad
  // planificada al proveedor elegido — 0 si no hay cantidad o solo hay un proveedor.
  ahorroTotalEstimado: number;
  // Sobrecoste, para la cantidad planificada, de haber elegido a mano un
  // proveedor distinto del recomendado (más barato) — 0 si coinciden.
  sobrecosteFrenteARecomendado: number;
  consumoReferencia: { temporadaNombre: string; cantidadNeta: number } | null;
  proveedorElegidoId: string | null;
  cantidadPlanificada: number;
  observaciones: string;
  costeTotalEstimado: number;
};

export async function getPlanificadorData(temporadaId: string) {
  const temporada = await prisma.temporada.findUnique({ where: { id: temporadaId } });
  if (!temporada) return null;

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

  const filas: FilaPlanificador[] = articulos.map((articulo) => {
    const precios = articulo.precios
      .filter((p) => p.proveedor.activo)
      .map((p) => ({
        proveedorId: p.proveedorId,
        proveedorNombre: p.proveedor.nombre,
        precioSinIva: p.precioSinIva,
        descuentoPercent: p.descuentoPercent,
        precioConIva: precioFinalUnidad(p.precioSinIva, p.descuentoPercent, articulo.ivaPercent),
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

    const ahorroTotalEstimado = Math.round(ahorro * cantidadPlanificada * 100) / 100;
    const sobrecosteFrenteARecomendado =
      precioElegido && recomendado && precioElegido.proveedorId !== recomendado.proveedorId
        ? Math.max(0, Math.round((precioElegido.precioConIva - recomendado.precioConIva) * cantidadPlanificada * 100) / 100)
        : 0;

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
      ahorroTotalEstimado,
      sobrecosteFrenteARecomendado,
      consumoReferencia: consumo ? { temporadaNombre: temporadaAnterior?.nombre ?? '', cantidadNeta: consumo.cantidadNeta } : null,
      proveedorElegidoId,
      cantidadPlanificada,
      observaciones: plan?.observaciones ?? '',
      costeTotalEstimado: precioElegido ? Math.round(precioElegido.precioConIva * cantidadPlanificada * 100) / 100 : 0,
    };
  });

  return { temporada, temporadaAnterior, filas };
}
