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

  return { temporada, pedidos };
}

export type PedidosParaExport = NonNullable<Awaited<ReturnType<typeof getPedidosParaExport>>>;
export type PedidoParaExport = PedidosParaExport['pedidos'][number];
