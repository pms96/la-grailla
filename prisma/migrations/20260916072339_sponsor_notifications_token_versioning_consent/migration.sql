-- CreateEnum
CREATE TYPE "SponsorEmailType" AS ENUM ('LEAD_CONFIRMATION', 'PORTAL_INVITE', 'PORTAL_INVITE_RESEND', 'STATUS_NOTIFY', 'REJECTION');

-- AlterTable
ALTER TABLE "Sponsor" ADD COLUMN     "invitationEmailError" TEXT,
ADD COLUMN     "invitationEmailStatus" TEXT,
ADD COLUMN     "invitationSentAt" TIMESTAMP(3),
ADD COLUMN     "portalTokenVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "SponsorRequest" ADD COLUMN     "consentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SponsorEmailLog" (
    "id" TEXT NOT NULL,
    "sponsorRequestId" TEXT,
    "sponsorId" TEXT,
    "type" "SponsorEmailType" NOT NULL,
    "recipient" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SponsorEmailLog_sponsorId_idx" ON "SponsorEmailLog"("sponsorId");

-- CreateIndex
CREATE INDEX "SponsorEmailLog_sponsorRequestId_idx" ON "SponsorEmailLog"("sponsorRequestId");

-- AddForeignKey
ALTER TABLE "SponsorEmailLog" ADD CONSTRAINT "SponsorEmailLog_sponsorRequestId_fkey" FOREIGN KEY ("sponsorRequestId") REFERENCES "SponsorRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorEmailLog" ADD CONSTRAINT "SponsorEmailLog_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorEmailLog" ADD CONSTRAINT "SponsorEmailLog_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
