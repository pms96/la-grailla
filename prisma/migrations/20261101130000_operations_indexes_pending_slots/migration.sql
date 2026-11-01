-- H-048 y H-051 (revisión integral, lote 6): índices que faltaban en las consultas calientes y una tabla propia para el cupo de pedidos pendientes por IP.
--
-- Aditiva y reejecutable (IF NOT EXISTS): no cambia ninguna columna existente ni lo que el código anterior lee o escribe. El único efecto sobre una tabla ya existente
-- es crear índices, que bloquea las ESCRITURAS de esa tabla mientras se construye (milisegundos con el volumen de un cliente normal). `CREATE INDEX CONCURRENTLY` no
-- se puede usar aquí (el runner migra dentro de una transacción), así que se migra FUERA de una venta en marcha, como ya exige el runner.
-- allow-lock: índices sobre tablas de un cliente normal (miles de filas, no millones): el bloqueo de escritura dura milisegundos y el runner no migra con una venta en marcha
-- front-min-schema: required el código de este release cuenta y libera los cupos en `PendingSlot` (tabla nueva): sin ella, comprar da un 500

-- H-048: consultas calientes sin índice.
CREATE INDEX IF NOT EXISTS "Ticket_eventId_status_idx" ON "Ticket"("eventId", "status");
CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order"("createdAt");
CREATE INDEX IF NOT EXISTS "ShopOrder_status_idx" ON "ShopOrder"("status");
CREATE INDEX IF NOT EXISTS "ShopOrder_createdAt_idx" ON "ShopOrder"("createdAt");
CREATE INDEX IF NOT EXISTS "ShopOrder_paymentId_idx" ON "ShopOrder"("paymentId");
CREATE INDEX IF NOT EXISTS "ScanLog_eventId_createdAt_idx" ON "ScanLog"("eventId", "createdAt");
CREATE INDEX IF NOT EXISTS "WaitingRoomEntry_status_joinedAt_idx" ON "WaitingRoomEntry"("status", "joinedAt");
-- H-047: las consultas de entrega de emails de la tienda recorren filas marcadoras recientes de ProcessedWebhookEvent; con este índice acotan por fecha.
CREATE INDEX IF NOT EXISTS "ProcessedWebhookEvent_processedAt_idx" ON "ProcessedWebhookEvent"("processedAt");

-- H-051: cupo de pedidos pendientes por IP.
CREATE TABLE IF NOT EXISTS "PendingSlot" (
  "ref" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PendingSlot_pkey" PRIMARY KEY ("ref")
);
CREATE INDEX IF NOT EXISTS "PendingSlot_scope_identifier_expiresAt_idx" ON "PendingSlot"("scope", "identifier", "expiresAt");
CREATE INDEX IF NOT EXISTS "PendingSlot_expiresAt_idx" ON "PendingSlot"("expiresAt");
