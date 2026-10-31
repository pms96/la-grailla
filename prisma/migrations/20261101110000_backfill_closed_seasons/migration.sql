-- H-008: las temporadas que ya estaban en CERRADA antes del control de cierre (P1-16) no tienen constancia de cuándo se cerraron (`closedAt` nulo).
-- Se anota la última modificación de la fila como fecha de cierre: es la mejor aproximación disponible. `closedById` se deja en blanco porque no se sabe
-- quién fue. NO reabre ni cambia el estado de ninguna temporada: el bloqueo (423) ya depende de `status`, no de `closedAt`. Idempotente.
-- front-min-schema: not-required relleno de datos; el front no lee nada nuevo (la columna `closedAt` ya la exige la migración de contabilidad)
UPDATE "Temporada" SET "closedAt" = "updatedAt" WHERE "status" = 'CERRADA' AND "closedAt" IS NULL;
