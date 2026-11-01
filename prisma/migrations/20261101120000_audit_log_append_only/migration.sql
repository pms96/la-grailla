-- H-026: el registro de auditoría (`AdminAuditLog`) era «de solo inserción» por convención: la aplicación no tiene ninguna ruta que edite o borre sus filas, pero
-- nada en la base de datos lo impedía (un bug, una consulta a mano o una inyección SQL podían reescribir el rastro). Ahora lo impide la propia BD: un trigger
-- rechaza UPDATE y DELETE sobre cada fila. TRUNCATE no se bloquea (lo usan el reinicio de las BDs de prueba y el borrado de un cliente completo).
--
-- Salida de emergencia: solo si la transacción declara `app.audit_maintenance = 'purge-audit-log'` (`SELECT set_config('app.audit_maintenance', 'purge-audit-log', true)`)
-- el trigger deja pasar. La usan únicamente los tests para limpiar sus filas; es una compuerta contra accidentes, no una defensa frente a quien ya tiene SQL libre.
-- Idempotente (CREATE OR REPLACE + DROP IF EXISTS) y aditiva: no cambia ninguna columna ni lo que el front lee o escribe.
-- front-min-schema: not-required el trigger no cambia nada que el front lea o escriba (solo impide UPDATE y DELETE sobre AdminAuditLog)
CREATE OR REPLACE FUNCTION admin_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.audit_maintenance', true) = 'purge-audit-log' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AdminAuditLog es de solo inserción (% bloqueado)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_log_no_update_delete ON "AdminAuditLog";
CREATE TRIGGER admin_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "AdminAuditLog"
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();
