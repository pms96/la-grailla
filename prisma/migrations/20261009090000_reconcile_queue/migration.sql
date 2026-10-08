-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconcileCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ShopOrder" ADD COLUMN     "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconcileCheckedAt" TIMESTAMP(3);
