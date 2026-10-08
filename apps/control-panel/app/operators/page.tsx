import { requireOperator } from '@/lib/guard';
import { listOperators } from '@/lib/queries';
import { createOperatorAction, resetOperatorAction, setRoleAction, toggleOperatorAction } from '../actions/operators';
import { ActionForm } from '../_components/action-form';
import { Pill, formatDate } from '../_components/ui';

export const dynamic = 'force-dynamic';

const ROLE_HELP: Record<string, string> = {
  VIEWER: 'Solo lectura',
  OPERATOR: 'Gestiona clientes y publica',
  BILLING: 'Licencias y cobros (lectura por ahora)',
  SUPERADMIN: 'Todo, incluidas bases de datos y operadores',
};

export default async function OperatorsPage() {
  const { live } = await requireOperator('operators:manage');
  const operators = await listOperators();
  return (
    <main>
      <div className="pagehead">
        <div>
          <h1>Operadores</h1>
          <p className="muted">Quién puede entrar al panel y con qué permisos.</p>
        </div>
      </div>
      <div className="panel tablewrap" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Operador</th>
              <th>Rol</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {operators.map((o) => {
              const me = o.id === live.operator.id;
              return (
                <tr key={o.id}>
                  <td>
                    <strong>{o.name}</strong> {me && <Pill>Tú</Pill>}
                    <div className="muted">{o.email}</div>
                  </td>
                  <td>
                    <ActionForm className="inline" action={setRoleAction.bind(null, o.id)} submitLabel="Cambiar">
                      <select name="role" defaultValue={o.role} aria-label={`Rol de ${o.email}`}>
                        {Object.keys(ROLE_HELP).map((r) => (
                          <option key={r} value={r}>
                            {r.toLowerCase()} — {ROLE_HELP[r]}
                          </option>
                        ))}
                      </select>
                    </ActionForm>
                  </td>
                  <td>
                    <div className="chips">
                      {o.disabledAt ? <Pill tone="bad">Deshabilitado</Pill> : <Pill tone="ok">Activo</Pill>}
                      {o.totpEnabledAt ? <Pill tone="ok">MFA</Pill> : <Pill tone="warn">Sin MFA</Pill>}
                      {o.lockedUntil && o.lockedUntil.getTime() > Date.now() && <Pill tone="warn">Bloqueado</Pill>}
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <ActionForm className="inline" action={toggleOperatorAction.bind(null, o.id, !o.disabledAt)} submitLabel={o.disabledAt ? 'Habilitar' : 'Deshabilitar'} tone={o.disabledAt ? 'quiet' : 'danger'} confirm={o.disabledAt ? undefined : `¿Deshabilitar a ${o.email}? Se cerrarán sus sesiones.`} />
                      <ActionForm className="inline" action={resetOperatorAction.bind(null, o.id)} submitLabel="Reiniciar acceso" tone="quiet" confirm={`¿Reiniciar contraseña y MFA de ${o.email}?`} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>Nuevo operador</h2>
        <ActionForm action={createOperatorAction} submitLabel="Crear operador">
          <div className="grid2">
            <label>
              Nombre
              <input name="name" type="text" required minLength={2} maxLength={120} />
            </label>
            <label>
              Email
              <input name="email" type="email" required maxLength={254} />
            </label>
          </div>
          <label>
            Rol
            <select name="role" defaultValue="OPERATOR">
              {Object.keys(ROLE_HELP).map((r) => (
                <option key={r} value={r}>
                  {r.toLowerCase()} — {ROLE_HELP[r]}
                </option>
              ))}
            </select>
          </label>
        </ActionForm>
      </div>
    </main>
  );
}
