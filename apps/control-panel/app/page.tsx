import Link from 'next/link';
import { listTenants } from '@/lib/queries';
import { can } from '@/lib/permissions';
import { requireOperator } from '@/lib/guard';
import { Pill, PublishPill, TenantStatusPill, formatDate } from './_components/ui';

export const dynamic = 'force-dynamic';

export default async function TenantsPage({ searchParams }: { searchParams: { denied?: string } }) {
  const { live } = await requireOperator('view');
  const rows = await listTenants();
  return (
    <main>
      <div className="pagehead">
        <div>
          <h1>Clientes</h1>
          <p className="muted">{rows.length === 0 ? 'Aún no hay ninguno.' : `${rows.length} ${rows.length === 1 ? 'cliente' : 'clientes'}`}</p>
        </div>
        {can(live.operator.role, 'database:write') && (
          <Link href="/tenants/new" className="btn" style={{ textDecoration: 'none' }}>
            Nuevo cliente
          </Link>
        )}
      </div>
      {searchParams.denied && <p className="msg error">No tienes permiso para esa acción.</p>}
      {rows.length === 0 ? (
        <div className="panel emptystate">
          <p>Todavía no hay clientes registrados.</p>
          {can(live.operator.role, 'database:write') && <Link href="/tenants/new">Dar de alta el primero</Link>}
        </div>
      ) : (
        <div className="panel tablewrap" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Estado</th>
                <th>Módulos</th>
                <th>Dominio</th>
                <th>Publicación</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ tenant, subscriptions }) =>
                subscriptions.map(({ sub, pending }) => {
                  const primary = sub.domains.find((d) => d.isPrimary && d.status === 'VERIFIED') ?? sub.domains.find((d) => d.status !== 'RELEASED');
                  const active = sub.domains.filter((d) => d.status !== 'RELEASED').length;
                  return (
                    <tr key={sub.id}>
                      <td>
                        <Link href={`/tenants/${tenant.id}`}>
                          <strong>{tenant.name}</strong>
                        </Link>
                        <div className="muted mono">{tenant.id}</div>
                      </td>
                      <td>
                        <TenantStatusPill status={tenant.status} />
                        {sub.status === 'SUSPENDED' && <Pill tone="warn">Suscripción suspendida</Pill>}
                      </td>
                      <td>
                        <div className="chips">
                          {sub.modules
                            .map((m) => m.moduleKey)
                            .sort()
                            .map((k) => (
                              <Pill key={k} tone={k === 'nucleo' ? undefined : 'accent'}>
                                {k}
                              </Pill>
                            ))}
                        </div>
                      </td>
                      <td>
                        {primary ? (
                          <>
                            <span className="mono">{primary.host}</span>
                            {active > 1 && <span className="muted"> +{active - 1}</span>}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <PublishPill pending={pending} seq={sub.snapshotSeq} error={sub.lastPublishError} hasPublished={sub.lastPublishedAt !== null} />
                        <div className="muted" style={{ fontSize: '.8rem' }}>
                          {formatDate(sub.lastPublishedAt)}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
