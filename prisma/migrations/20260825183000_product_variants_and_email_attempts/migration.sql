-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '',
    "stock" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "emailLastError" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "emailAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_size_color_key" ON "ProductVariant"("productId", "size", "color");

-- CreateIndex
CREATE INDEX "Order_status_emailSentAt_idx" ON "Order"("status", "emailSentAt");

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
