-- H-071: latido de la sala de espera. Una sola columna anulable: aditiva, compatible con el front anterior (que no la escribe; una fila con
-- `lastSeenAt` nulo cuenta como vista en `joinedAt`).

-- AlterTable
ALTER TABLE "WaitingRoomEntry" ADD COLUMN     "lastSeenAt" TIMESTAMP(3);
