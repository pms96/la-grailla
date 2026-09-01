-- CreateEnum
CREATE TYPE "SponsorPortalStatus" AS ENUM ('PENDIENTE_MATERIALES', 'PENDIENTE_REVISION', 'LISTO_PARA_GENERAR', 'PROMPT_GENERADO', 'APROBADO_PARA_VIDEO', 'RECHAZADO');

-- CreateTable
CREATE TABLE "Sponsor" (
    "id" TEXT NOT NULL,
    "sponsorRequestId" TEXT NOT NULL,
    "status" "SponsorPortalStatus" NOT NULL DEFAULT 'PENDIENTE_MATERIALES',
    "guidedAnswers" JSONB,
    "freeText" TEXT,
    "currentAssetId" TEXT,
    "isGenerating" BOOLEAN NOT NULL DEFAULT false,
    "generationCount" INTEGER NOT NULL DEFAULT 0,
    "maxGenerations" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorAsset" (
    "id" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorVideoPrompt" (
    "id" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "promptEs" TEXT NOT NULL,
    "promptEn" TEXT NOT NULL,
    "sourceLogId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorVideoPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptGenerationLog" (
    "id" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "adminId" TEXT,
    "assetIdUsed" TEXT,
    "descriptionSnapshot" TEXT,
    "guidedAnswersSnapshot" JSONB,
    "rawResponse" JSONB,
    "promptEs" TEXT,
    "promptEn" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptGenerationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sponsor_sponsorRequestId_key" ON "Sponsor"("sponsorRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Sponsor_currentAssetId_key" ON "Sponsor"("currentAssetId");

-- CreateIndex
CREATE INDEX "Sponsor_status_idx" ON "Sponsor"("status");

-- CreateIndex
CREATE INDEX "SponsorAsset_sponsorId_idx" ON "SponsorAsset"("sponsorId");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorVideoPrompt_sponsorId_key" ON "SponsorVideoPrompt"("sponsorId");

-- CreateIndex
CREATE INDEX "PromptGenerationLog_sponsorId_idx" ON "PromptGenerationLog"("sponsorId");

-- AddForeignKey
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_sponsorRequestId_fkey" FOREIGN KEY ("sponsorRequestId") REFERENCES "SponsorRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_currentAssetId_fkey" FOREIGN KEY ("currentAssetId") REFERENCES "SponsorAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorAsset" ADD CONSTRAINT "SponsorAsset_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorVideoPrompt" ADD CONSTRAINT "SponsorVideoPrompt_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorVideoPrompt" ADD CONSTRAINT "SponsorVideoPrompt_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptGenerationLog" ADD CONSTRAINT "PromptGenerationLog_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptGenerationLog" ADD CONSTRAINT "PromptGenerationLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
