-- CreateEnum
CREATE TYPE "TemporadaStatus" AS ENUM ('ABIERTA', 'CERRADA');

-- CreateEnum
CREATE TYPE "PedidoStatus" AS ENUM ('BORRADOR', 'ENVIADO', 'RECIBIDO');

-- CreateTable
CREATE TABLE "Temporada" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "fechaInicio" TIMESTAMP(3),
    "fechaFin" TIMESTAMP(3),
    "status" "TemporadaStatus" NOT NULL DEFAULT 'ABIERTA',
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Temporada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proveedor" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "contacto" TEXT,
    "telefono" TEXT,
    "email" TEXT,
    "notas" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Articulo" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "formato" TEXT NOT NULL,
    "unidadesPorCaja" INTEGER NOT NULL DEFAULT 1,
    "ivaPercent" DOUBLE PRECISION NOT NULL DEFAULT 21,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Articulo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrecioArticulo" (
    "id" TEXT NOT NULL,
    "articuloId" TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "precioSinIva" DOUBLE PRECISION NOT NULL,
    "formatoVenta" TEXT NOT NULL,
    "unidadMinPedido" INTEGER NOT NULL DEFAULT 1,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrecioArticulo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumoHistorico" (
    "id" TEXT NOT NULL,
    "articuloId" TEXT NOT NULL,
    "temporadaId" TEXT NOT NULL,
    "cantidadNeta" DOUBLE PRECISION NOT NULL,
    "fuenteDatos" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumoHistorico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanCompra" (
    "id" TEXT NOT NULL,
    "temporadaId" TEXT NOT NULL,
    "articuloId" TEXT NOT NULL,
    "proveedorElegidoId" TEXT,
    "cantidadPlanificada" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "observaciones" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pedido" (
    "id" TEXT NOT NULL,
    "temporadaId" TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "status" "PedidoStatus" NOT NULL DEFAULT 'BORRADOR',
    "fechaPedido" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaEnviado" TIMESTAMP(3),
    "fechaRecibido" TIMESTAMP(3),
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineaPedido" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "articuloId" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "precioSinIva" DOUBLE PRECISION NOT NULL,
    "ivaPercent" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "LineaPedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gasto" (
    "id" TEXT NOT NULL,
    "temporadaId" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "concepto" TEXT NOT NULL,
    "proveedorId" TEXT,
    "pedidoId" TEXT,
    "importeSinIva" DOUBLE PRECISION NOT NULL,
    "ivaPercent" DOUBLE PRECISION NOT NULL DEFAULT 21,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "numDocumento" TEXT,
    "tipoDocumento" TEXT NOT NULL DEFAULT 'Factura',
    "notas" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gasto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Temporada_anio_idx" ON "Temporada"("anio");

-- CreateIndex
CREATE INDEX "Articulo_categoria_idx" ON "Articulo"("categoria");

-- CreateIndex
CREATE INDEX "PrecioArticulo_articuloId_idx" ON "PrecioArticulo"("articuloId");

-- CreateIndex
CREATE INDEX "PrecioArticulo_proveedorId_idx" ON "PrecioArticulo"("proveedorId");

-- CreateIndex
CREATE UNIQUE INDEX "PrecioArticulo_articuloId_proveedorId_key" ON "PrecioArticulo"("articuloId", "proveedorId");

-- CreateIndex
CREATE INDEX "ConsumoHistorico_temporadaId_idx" ON "ConsumoHistorico"("temporadaId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumoHistorico_articuloId_temporadaId_key" ON "ConsumoHistorico"("articuloId", "temporadaId");

-- CreateIndex
CREATE INDEX "PlanCompra_temporadaId_idx" ON "PlanCompra"("temporadaId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanCompra_temporadaId_articuloId_key" ON "PlanCompra"("temporadaId", "articuloId");

-- CreateIndex
CREATE INDEX "Pedido_temporadaId_status_idx" ON "Pedido"("temporadaId", "status");

-- CreateIndex
CREATE INDEX "Pedido_proveedorId_idx" ON "Pedido"("proveedorId");

-- CreateIndex
CREATE INDEX "LineaPedido_pedidoId_idx" ON "LineaPedido"("pedidoId");

-- CreateIndex
CREATE UNIQUE INDEX "Gasto_pedidoId_key" ON "Gasto"("pedidoId");

-- CreateIndex
CREATE INDEX "Gasto_temporadaId_categoria_idx" ON "Gasto"("temporadaId", "categoria");

-- CreateIndex
CREATE INDEX "Gasto_proveedorId_idx" ON "Gasto"("proveedorId");

-- AddForeignKey
ALTER TABLE "PrecioArticulo" ADD CONSTRAINT "PrecioArticulo_articuloId_fkey" FOREIGN KEY ("articuloId") REFERENCES "Articulo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrecioArticulo" ADD CONSTRAINT "PrecioArticulo_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "Proveedor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumoHistorico" ADD CONSTRAINT "ConsumoHistorico_articuloId_fkey" FOREIGN KEY ("articuloId") REFERENCES "Articulo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumoHistorico" ADD CONSTRAINT "ConsumoHistorico_temporadaId_fkey" FOREIGN KEY ("temporadaId") REFERENCES "Temporada"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanCompra" ADD CONSTRAINT "PlanCompra_temporadaId_fkey" FOREIGN KEY ("temporadaId") REFERENCES "Temporada"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanCompra" ADD CONSTRAINT "PlanCompra_articuloId_fkey" FOREIGN KEY ("articuloId") REFERENCES "Articulo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanCompra" ADD CONSTRAINT "PlanCompra_proveedorElegidoId_fkey" FOREIGN KEY ("proveedorElegidoId") REFERENCES "Proveedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_temporadaId_fkey" FOREIGN KEY ("temporadaId") REFERENCES "Temporada"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "Proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaPedido" ADD CONSTRAINT "LineaPedido_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "Pedido"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaPedido" ADD CONSTRAINT "LineaPedido_articuloId_fkey" FOREIGN KEY ("articuloId") REFERENCES "Articulo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_temporadaId_fkey" FOREIGN KEY ("temporadaId") REFERENCES "Temporada"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "Proveedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "Pedido"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
