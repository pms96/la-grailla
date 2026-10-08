import { requireOperator } from '@/lib/guard';
import { prisma } from '@/lib/db';
import { listLicenseKeys } from '@/lib/services/license';
import { createKeyAction } from '../actions/licenses';
import { ActionForm } from '../_components/action-form';
import { Pill, formatDate } from '../_components/ui';

export const dynamic = 'force-dynamic';

export default async function LicensesPage() {
  await requireOperator('billing:write');
  const [keys, modules] = await Promise.all([listLicenseKeys(), prisma.moduleDef.findMany({ where: { productKey: 'grailla', isCore: false }, orderBy: { sortOrder: 'asc' } })]);

  return (
    <main>
      <div className="pagehead">
        <div>
          <h1>Claves de licencia</h1>
          <p className="muted">Un código canjeable activa módulos y/o alarga la vigencia de un cliente. Un solo uso.</p>
        </div>
      </div>

      <div className="panel">
        <h2>Crear una clave</h2>
        <ActionForm action={createKeyAction} submitLabel="Crear clave">
          <fieldset>
            <legend>Módulos que activa</legend>
            {modules.map((m) => (
              <label key={m.key} className="check">
                <input type="checkbox" name="modules" value={m.key} />
                {m.name}
              </label>
            ))}
          </fieldset>
          <label>
            Días de vigencia que añade (0 = ninguno)
            <input name="extendDays" type="number" min={0} max={1100} defaultValue={0} />
          </label>
          <label>
            La clave caduca a los (días, vacío = nunca)
            <input name="expiresInDays" type="number" min={1} max={730} />
          </label>
          <label>
            Nota interna
            <input name="note" type="text" maxLength={200} />
          </label>
        </ActionForm>
      </div>

      <div className="panel">
        <h2>Claves creadas</h2>
        {keys.length === 0 ? (
          <p className="muted">Todavía no hay claves.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Clave</th>
                  <th>Activa</th>
                  <th>Estado</th>
                  <th>Nota</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td className="mono">{k.codePrefix}…</td>
                    <td>
                      {k.modules.length ? k.modules.join(', ') : '—'}
                      {k.extendDays > 0 && <span className="muted"> · +{k.extendDays} días</span>}
                    </td>
                    <td>
                      {k.redeemedAt ? (
                        <Pill>Canjeada {formatDate(k.redeemedAt)}</Pill>
                      ) : k.expiresAt && k.expiresAt.getTime() < Date.now() ? (
                        <Pill tone="bad">Caducada</Pill>
                      ) : (
                        <Pill tone="ok">Disponible</Pill>
                      )}
                    </td>
                    <td className="muted">{k.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
