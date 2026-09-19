-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "ageWarningEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ageWarningMessage" TEXT;
