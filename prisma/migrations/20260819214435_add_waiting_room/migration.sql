-- CreateEnum
CREATE TYPE "WaitingRoomStatus" AS ENUM ('WAITING', 'ADMITTED', 'COMPLETED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "waitingRoomConcurrentSlots" INTEGER,
ADD COLUMN     "waitingRoomEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "waitingRoomMessage" TEXT,
ADD COLUMN     "waitingRoomPurchaseWindowSeconds" INTEGER;

-- CreateTable
CREATE TABLE "WaitingRoomEntry" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "WaitingRoomStatus" NOT NULL DEFAULT 'WAITING',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "admittedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "WaitingRoomEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaitingRoomEntry_token_key" ON "WaitingRoomEntry"("token");

-- CreateIndex
CREATE INDEX "WaitingRoomEntry_eventId_status_joinedAt_idx" ON "WaitingRoomEntry"("eventId", "status", "joinedAt");

-- AddForeignKey
ALTER TABLE "WaitingRoomEntry" ADD CONSTRAINT "WaitingRoomEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
