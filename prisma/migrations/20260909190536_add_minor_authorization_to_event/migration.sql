-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "minorAuthorizationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "minorAuthorizationText" TEXT;
