-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "graceDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "paidThrough" TIMESTAMP(3),
ADD COLUMN     "panelBlockedDays" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "emergencyRevokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LicenseKey" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "modules" TEXT[],
    "extendDays" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedBySubscriptionId" TEXT,
    "redeemedBy" TEXT,

    CONSTRAINT "LicenseKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LicenseKey_codeHash_key" ON "LicenseKey"("codeHash");

-- CreateIndex
CREATE INDEX "LicenseKey_redeemedAt_idx" ON "LicenseKey"("redeemedAt");
