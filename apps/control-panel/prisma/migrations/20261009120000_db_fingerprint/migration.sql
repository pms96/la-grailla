-- Huella de la BD de cada cliente (servidor + puerto + nombre): única, para que dos clientes no puedan registrarse con la misma BD.
-- Aditiva: columna nullable y un índice único (varios NULL no chocan). Las altas anteriores se rellenan al registrar el siguiente cliente.
ALTER TABLE "Subscription" ADD COLUMN "dbFingerprint" TEXT;
CREATE UNIQUE INDEX "Subscription_dbFingerprint_key" ON "Subscription"("dbFingerprint");
