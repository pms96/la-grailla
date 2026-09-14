import { prisma } from '@/lib/prisma';

export async function getPedidosParaExport(temporadaId: string) {
  const temporada = await prisma.temporada.findUnique({ where: { id: temporadaId } });
  if (!temporada) return null;

  const pedidos = await prisma.pedido.findMany({
    where: { temporadaId },
    orderBy: { proveedor: { nombre: 'asc' } },
    include: {
      proveedor: true,
      lineas: { include: { articulo: true }, orderBy: { articulo: { nombre: 'asc' } } },
    },
  });

  // El formato de venta de cada proveedor (p.ej. "Caja 24uds") vive en PrecioArticulo,
  // aparte del formato general del artículo — se resuelve aquí, por par artículo+proveedor,
  // para que los exports puedan ofrecer uno u otro sin tocar la consulta principal.
  const proveedorIds = [...new Set(pedidos.map((p) => p.proveedorId))];
  const precios = proveedorIds.length
    ? await prisma.precioArticulo.findMany({ where: { proveedorId: { in: proveedorIds } } })
    : [];
  const formatoProveedorPorClave = new Map(precios.map((p) => [`${p.articuloId}_${p.proveedorId}`, p.formatoVenta]));

  return { temporada, pedidos, formatoProveedorPorClave };
}

export type PedidosParaExport = NonNullable<Awaited<ReturnType<typeof getPedidosParaExport>>>;
export type PedidoParaExport = PedidosParaExport['pedidos'][number];
