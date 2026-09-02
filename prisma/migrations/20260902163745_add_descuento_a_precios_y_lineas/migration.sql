-- AlterTable
ALTER TABLE "LineaPedido" ADD COLUMN     "descuentoPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PrecioArticulo" ADD COLUMN     "descuentoPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;
