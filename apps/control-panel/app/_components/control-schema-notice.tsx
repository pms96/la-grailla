import { controlSchemaNotice, controlSchemaStatus } from '@/lib/services/control-schema';

/** Aviso en el layout raíz (se ve también antes de iniciar sesión) cuando la BD de control va por detrás del panel desplegado (lote 16, B). Sin migraciones nombradas ni datos. */
export async function ControlSchemaNotice() {
  const notice = controlSchemaNotice(await controlSchemaStatus());
  if (!notice) return null;
  return (
    <div role="alert" className="schema-notice">
      <strong>{notice.title}.</strong> {notice.detail}
    </div>
  );
}
