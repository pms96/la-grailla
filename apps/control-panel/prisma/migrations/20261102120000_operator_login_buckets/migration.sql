-- H-170: cupo de intentos fallidos de login por (operador, IP). Aditiva: una tabla nueva (no toca filas ni columnas existentes).
CREATE TABLE "OperatorLoginBucket" (
    "operatorId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorLoginBucket_pkey" PRIMARY KEY ("operatorId","ip")
);

CREATE INDEX "OperatorLoginBucket_updatedAt_idx" ON "OperatorLoginBucket"("updatedAt");

ALTER TABLE "OperatorLoginBucket" ADD CONSTRAINT "OperatorLoginBucket_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
