import { prisma } from '@/lib/db';
import { requireOperator } from '@/lib/guard';
import { createTenantAction } from '../../actions/tenants';
import { ActionForm } from '../../_components/action-form';

export const dynamic = 'force-dynamic';

export default async function NewTenantPage() {
  await requireOperator('database:write');
  const modules = await prisma.moduleDef.findMany({ where: { productKey: 'grailla', isCore: false }, orderBy: { sortOrder: 'asc' } });
  return (
    <main>
      <div className="pagehead">
        <div>
          <h1>Nuevo cliente</h1>
          <p className="muted">Se crea sin publicar: primero hay que verificar el dominio.</p>
        </div>
      </div>
      <div className="panel">
        <ActionForm action={createTenantAction} submitLabel="Crear cliente">
          <input type="hidden" name="productKey" value="grailla" />
          <label>
            Nombre
            <input name="name" type="text" required minLength={2} maxLength={120} placeholder="Peña Los Cuatro" />
          </label>
          <label>
            Dominio principal
            <input name="primaryHost" type="text" required placeholder="www.cliente.es" autoCapitalize="none" spellCheck={false} />
          </label>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ fontSize: '.85rem', fontWeight: 600, marginBottom: '.4rem' }}>
              Módulos (el Núcleo va siempre)
            </legend>
            <div className="stack">
              {modules.map((m) => (
                <label key={m.key} className="check">
                  <input type="checkbox" name="modules" value={m.key} />
                  {m.name}
                  {m.monthlyAddon && <span className="muted"> · suplemento mensual</span>}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            URL de la base de datos (pooled)
            <input name="dbUrlPooled" type="password" autoComplete="off" required placeholder="postgresql://…-pooler…" spellCheck={false} />
          </label>
          <label>
            URL de la base de datos (directa, para migraciones)
            <input name="dbUrlDirect" type="password" autoComplete="off" required placeholder="postgresql://…" spellCheck={false} />
          </label>
          <div className="grid2">
            <label>
              Región de la BD (opcional)
              <input name="dbRegion" type="text" placeholder="aws-eu-central-1" />
            </label>
            <label>
              Versión del esquema (opcional)
              <input name="schemaVersion" type="text" placeholder="20260930110333_add_ingreso_model" />
            </label>
          </div>
          <p className="muted" style={{ fontSize: '.85rem', margin: 0 }}>
            Las URLs se guardan cifradas y no se vuelven a mostrar en ninguna pantalla.
          </p>
        </ActionForm>
      </div>
    </main>
  );
}
