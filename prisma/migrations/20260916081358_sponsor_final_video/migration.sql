-- AlterTable
ALTER TABLE "Sponsor" ADD COLUMN     "finalVideoFileName" TEXT,
ADD COLUMN     "finalVideoSize" INTEGER,
ADD COLUMN     "finalVideoUploadedAt" TIMESTAMP(3),
ADD COLUMN     "finalVideoUrl" TEXT;
