-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "archivado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "temporadaId" TEXT;

-- AlterTable
ALTER TABLE "Temporada" ADD COLUMN     "archivado" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Event_temporadaId_idx" ON "Event"("temporadaId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_temporadaId_fkey" FOREIGN KEY ("temporadaId") REFERENCES "Temporada"("id") ON DELETE SET NULL ON UPDATE CASCADE;
