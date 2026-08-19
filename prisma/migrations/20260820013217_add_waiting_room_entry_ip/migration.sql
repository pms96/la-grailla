-- AlterTable
ALTER TABLE "WaitingRoomEntry" ADD COLUMN "ip" TEXT;

-- CreateIndex
CREATE INDEX "WaitingRoomEntry_eventId_ip_status_idx" ON "WaitingRoomEntry"("eventId", "ip", "status");
