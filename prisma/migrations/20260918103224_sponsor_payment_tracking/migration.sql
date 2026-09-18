-- AlterTable
ALTER TABLE "Sponsor" ADD COLUMN     "isPaid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paidAmount" DECIMAL(10,2),
ADD COLUMN     "paidAt" TIMESTAMP(3);
