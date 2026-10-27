-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "ageConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT,
ADD COLUMN     "vatRate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ShopOrder" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT,
ADD COLUMN     "vatRate" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "LegalSnapshot" (
    "hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalSnapshot_pkey" PRIMARY KEY ("hash")
);
