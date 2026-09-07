-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "temporadaId" TEXT;

-- AlterTable
ALTER TABLE "ShopOrder" ADD COLUMN     "temporadaId" TEXT;

-- AlterTable
ALTER TABLE "SponsorRequest" ADD COLUMN     "temporadaId" TEXT;

-- CreateIndex
CREATE INDEX "Product_temporadaId_idx" ON "Product"("temporadaId");

-- CreateIndex
CREATE INDEX "ShopOrder_temporadaId_idx" ON "ShopOrder"("temporadaId");

-- CreateIndex
CREATE INDEX "SponsorRequest_temporadaId_idx" ON "SponsorRequest"("temporadaId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_temporadaId_fkey" FOREIGN KEY ("temporadaId") REFERENCES "Temporada"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_temporadaId_fkey" FOREIGN KEY ("temporadaId") REFERENCES "Temporada"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorRequest" ADD CONSTRAINT "SponsorRequest_temporadaId_fkey" FOREIGN KEY ("temporadaId") REFERENCES "Temporada"("id") ON DELETE SET NULL ON UPDATE CASCADE;
