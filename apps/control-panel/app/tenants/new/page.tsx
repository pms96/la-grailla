import { prisma } from '@/lib/db';
import { requireOperator } from '@/lib/guard';
import { vercelConfig } from '@/lib/services/vercel-domains';
import { createTenantAction, provisionAction } from '../../actions/tenants';
import { ActionForm } from '../../_components/action-form';

export const dynamic = 'force-dynamic';
// El alta migra la BD del cliente (decenas de migraciones en una BD vacía): más de los 10-15 s por defecto de Vercel.
export const maxDuration = 300;

export default async function NewTenantPage() {
  await requireOperator('database:write');
  const modules = await prisma.moduleDef.findMany({ where: { productKey: 'grailla', isCore: false }, orderBy: { sortOrder: 'asc' } });
  const vercel = vercelConfig() !== null;
  const legalHint = 'Texto completo. Lo puede cambiar después el cliente desde su administración.';
  return (
    <main>
      <div className="pagehead">
        <div>
          <h1>Nuevo cliente</h1>
          <p className="muted">Hace todo el alta de una vez: registra, migra su BD, siembra sus datos, crea su administrador, verifica el dominio y publica. Si se corta, repites con los mismos datos y continúa donde se quedó.</p>
        </div>
      </div>

      <div className="panel">
        <h2>Alta completa</h2>
        <p className="muted">
          Antes, en Neon: crea el proyecto del cliente (Postgres 16, región Frankfurt) y copia sus dos URLs de conexión (pooled y directa).
        </p>
        <ActionForm action={provisionAction} submitLabel="Dar de alta">
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ fontSize: '.85rem', fontWeight: 600, marginBottom: '.4rem' }}>Cliente</legend>
            <label>
              Nombre
              <input name="name" type="text" required minLength={2} maxLength={120} placeholder="Peña Los Cuatro" />
            </label>
            <label>
              Dominio principal
              <input name="primaryHost" type="text" required placeholder="www.cliente.es" autoCapitalize="none" spellCheck={false} />
            </label>
            <div className="stack">
              <span className="muted" style={{ fontSize: '.85rem', fontWeight: 600 }}>Módulos (el Núcleo va siempre)</span>
              {modules.map((m) => (
                <label key={m.key} className="check">
                  <input type="checkbox" name="modules" value={m.key} />
                  {m.name}
                  {m.monthlyAddon && <span className="muted"> · suplemento mensual</span>}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ fontSize: '.85rem', fontWeight: 600, marginBottom: '.4rem' }}>Base de datos</legend>
            <label>
              URL pooled
              <input name="dbUrlPooled" type="password" autoComplete="off" required placeholder="postgresql://…-pooler…" spellCheck={false} />
            </label>
            <label>
              URL directa (para migraciones)
              <input name="dbUrlDirect" type="password" autoComplete="off" required placeholder="postgresql://…" spellCheck={false} />
            </label>
            <label>
              Región (opcional)
              <input name="dbRegion" type="text" placeholder="aws-eu-central-1" />
            </label>
            <p className="muted" style={{ fontSize: '.85rem', margin: 0 }}>Las URLs se guardan cifradas y no se vuelven a mostrar en ninguna pantalla.</p>
          </fieldset>

          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ fontSize: '.85rem', fontWeight: 600, marginBottom: '.4rem' }}>Administrador y datos del cliente</legend>
            <label>
              Email de administración (recibe los avisos de la web)
              <input name="adminEmail" type="email" required placeholder="administracion@cliente.es" autoCapitalize="none" spellCheck={false} />
            </label>
            <div className="grid2">
              <label>
                Nombre del administrador
                <input name="adminName" type="text" placeholder="Administrador" />
              </label>
              <label>
                Email del usuario administrador (si es otro)
                <input name="adminUserEmail" type="email" placeholder="el mismo de arriba" autoCapitalize="none" spellCheck={false} />
              </label>
            </div>
            <label>
              Aviso legal
              <textarea name="legal_notice" rows={4} placeholder={legalHint} />
            </label>
            <label>
              Política de privacidad
              <textarea name="privacy_policy" rows={4} placeholder={legalHint} />
            </label>
            <label>
              Política de cookies
              <textarea name="cookies_policy" rows={4} placeholder={legalHint} />
            </label>
            <label className="check">
              <input type="checkbox" name="allowIncomplete" /> Dar de alta aunque falten textos legales (no se publica hasta completarlos)
            </label>
          </fieldset>

          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ fontSize: '.85rem', fontWeight: 600, marginBottom: '.4rem' }}>Salida a producción</legend>
            <label>
              Verificación del dominio
              <select name="domainMode" defaultValue="dns">
                <option value="dns">Por DNS (el cliente crea un registro TXT; si aún no está, se deja pendiente)</option>
                <option value="manual">Darlo por verificado sin comprobar el DNS (queda auditado)</option>
                <option value="pending">Dejarlo pendiente</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" name="publish" defaultChecked /> Publicar en cuanto el dominio esté verificado y los datos completos
            </label>
            <label className="check">
              <input type="checkbox" name="invite" defaultChecked /> Invitar al administrador por correo en lugar de enseñar una contraseña temporal (si el dominio aún no está verificado, la invitación se envía desde la ficha)
            </label>
            <p className="muted" style={{ fontSize: '.85rem', margin: 0 }}>
              {vercel
                ? 'El dominio se añade al proyecto de Vercel de la plataforma automáticamente y se te dirá qué registro DNS crear.'
                : 'Falta configurar VERCEL_API_TOKEN y VERCEL_PLATFORM_PROJECT_ID en el panel para añadir el dominio en Vercel desde aquí: hasta entonces, se añade a mano en el proyecto grailla-platform.'}
            </p>
          </fieldset>
        </ActionForm>
      </div>

      <details className="panel">
        <summary>Solo registrar (sin migrar ni sembrar)</summary>
        <p className="muted">Para una BD que ya está migrada y con datos. El cliente queda sin publicar; los pasos que falten se hacen desde su ficha.</p>
        <ActionForm action={createTenantAction} submitLabel="Registrar cliente">
          <input type="hidden" name="productKey" value="grailla" />
          <label>
            Nombre
            <input name="name" type="text" required minLength={2} maxLength={120} placeholder="Peña Los Cuatro" />
          </label>
          <label>
            Dominio principal
            <input name="primaryHost" type="text" required placeholder="www.cliente.es" autoCapitalize="none" spellCheck={false} />
          </label>
          <div className="stack">
            {modules.map((m) => (
              <label key={m.key} className="check">
                <input type="checkbox" name="modules" value={m.key} />
                {m.name}
              </label>
            ))}
          </div>
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
        </ActionForm>
      </details>
    </main>
  );
}
