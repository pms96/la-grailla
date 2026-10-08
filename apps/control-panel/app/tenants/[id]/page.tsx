import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOperator } from '@/lib/guard';
import { can } from '@/lib/permissions';
import { getTenantDetail, recentAudit } from '@/lib/queries';
import { verificationRecordName, verificationRecordValue } from '@/lib/services/domains';
import { buildRoutingRecord } from '@/lib/services/snapshot';
import {
  addDomainAction,
  bumpEpochAction,
  publishAction,
  releaseDomainAction,
  replaceDbAction,
  setModulesAction,
  setPrimaryAction,
  setStatusAction,
  verifyDnsAction,
  verifyManualAction,
} from '../../actions/tenants';
import { ActionForm } from '../../_components/action-form';
import { DomainStatusPill, Pill, PublishPill, TenantStatusPill, formatDate } from '../../_components/ui';

export const dynamic = 'force-dynamic';

export default async function TenantPage({ params }: { params: { id: string } }) {
  const { live } = await requireOperator('view');
  const role = live.operator.role;
  const detail = await getTenantDetail(params.id);
  if (!detail) notFound();
  const { tenant, subscriptions } = detail;
  const audit = await recentAudit({ tenantId: tenant.id, take: 15 });
  const canWrite = can(role, 'tenants:write');

  return (
    <main>
      <p style={{ margin: 0 }}>
        <Link href="/">← Clientes</Link>
      </p>
      <div className="pagehead">
        <div>
          <h1>{tenant.name}</h1>
          <p className="muted mono">{tenant.id}</p>
        </div>
        <div className="row">
          <TenantStatusPill status={tenant.status} />
          {canWrite && tenant.status === 'ACTIVE' && (
            <ActionForm className="inline" action={setStatusAction.bind(null, tenant.id, 'SUSPENDED')} submitLabel="Suspender" tone="danger" confirm="¿Suspender este cliente? Tendrás que publicar para que se aplique." />
          )}
          {canWrite && tenant.status === 'SUSPENDED' && (
            <ActionForm className="inline" action={setStatusAction.bind(null, tenant.id, 'ACTIVE')} submitLabel="Reactivar" tone="quiet" />
          )}
        </div>
      </div>

      {subscriptions.map(({ sub, pending }) => {
        const enabled = new Set(sub.modules.map((m) => m.moduleKey));
        let preview: string | null = null;
        let previewError: string | null = null;
        try {
          preview = JSON.stringify(buildRoutingRecord(sub), null, 2);
        } catch (e) {
          previewError = e instanceof Error ? e.message : 'No se puede construir el registro';
        }
        const live_domains = sub.domains.filter((d) => d.status !== 'RELEASED');
        const released = sub.domains.filter((d) => d.status === 'RELEASED');
        return (
          <section key={sub.id} aria-label={`Producto ${sub.product.name}`}>
            <div className="panel">
              <div className="pagehead" style={{ marginBottom: '.5rem' }}>
                <h2 style={{ margin: 0 }}>Publicación · {sub.product.name}</h2>
                <PublishPill pending={pending} seq={sub.snapshotSeq} error={sub.lastPublishError} hasPublished={sub.lastPublishedAt !== null} />
              </div>
              {sub.lastPublishError && <p className="msg error">Último intento fallido: {sub.lastPublishError}</p>}
              <p className="muted">
                Lo que ve la web del cliente solo cambia al publicar. Última publicación: {formatDate(sub.lastPublishedAt)} · versión {sub.snapshotSeq}.
              </p>
              {can(role, 'publish') ? (
                <ActionForm className="inline" action={publishAction.bind(null, tenant.id, sub.id)} submitLabel={pending ? 'Publicar cambios' : 'Publicar de nuevo'} />
              ) : (
                <p className="muted">Tu rol no puede publicar.</p>
              )}
              {previewError ? (
                <p className="msg error" style={{ marginTop: '.75rem' }}>{previewError}</p>
              ) : (
                <details style={{ marginTop: '.75rem' }}>
                  <summary>Registro que se publicará (sin secretos)</summary>
                  <pre className="mono" style={{ overflowX: 'auto' }}>{preview}</pre>
                </details>
              )}
            </div>

            <div className="grid2">
              <div className="panel">
                <h2>Módulos</h2>
                {canWrite ? (
                  <ActionForm action={setModulesAction.bind(null, tenant.id, sub.id)} submitLabel="Guardar módulos">
                    {sub.product.modules.map((m) => (
                      <label key={m.key} className="check">
                        <input type="checkbox" name="modules" value={m.key} defaultChecked={enabled.has(m.key)} disabled={m.isCore} />
                        {m.name}
                        {m.isCore && <span className="muted"> · siempre activo</span>}
                        {m.monthlyAddon && <span className="muted"> · suplemento mensual</span>}
                      </label>
                    ))}
                  </ActionForm>
                ) : (
                  <div className="chips">
                    {[...enabled].sort().map((k) => (
                      <Pill key={k} tone="accent">
                        {k}
                      </Pill>
                    ))}
                  </div>
                )}
              </div>

              <div className="panel">
                <h2>Base de datos</h2>
                <dl className="kv">
                  <dt>Clúster</dt>
                  <dd>{sub.dbCluster}</dd>
                  <dt>Región</dt>
                  <dd>{sub.dbRegion ?? '—'}</dd>
                  <dt>Esquema</dt>
                  <dd className="mono">{sub.schemaVersion ?? 'sin informar'}</dd>
                  <dt>Celda</dt>
                  <dd>{sub.cell}</dd>
                  <dt>Época</dt>
                  <dd>{sub.epoch}</dd>
                  <dt>Conexión</dt>
                  <dd>
                    <Pill tone="ok">Cifrada</Pill> <span className="muted">no se puede ver</span>
                  </dd>
                </dl>
                {canWrite && (
                  <div style={{ marginTop: '.75rem' }}>
                    <ActionForm className="inline" action={bumpEpochAction.bind(null, tenant.id, sub.id)} submitLabel="Cerrar sesiones del cliente" tone="quiet" confirm="Sube la época: al publicar, todas las sesiones y enlaces de este cliente dejarán de valer. ¿Continuar?" />
                  </div>
                )}
                {can(role, 'database:write') && (
                  <details style={{ marginTop: '.75rem' }}>
                    <summary>Sustituir las URLs de conexión</summary>
                    <ActionForm action={replaceDbAction.bind(null, tenant.id, sub.id)} submitLabel="Guardar URLs">
                      <label>
                        URL pooled
                        <input name="pooled" type="password" autoComplete="off" required spellCheck={false} />
                      </label>
                      <label>
                        URL directa
                        <input name="direct" type="password" autoComplete="off" required spellCheck={false} />
                      </label>
                      <label>
                        Versión del esquema (opcional)
                        <input name="schemaVersion" type="text" />
                      </label>
                    </ActionForm>
                  </details>
                )}
              </div>
            </div>

            <div className="panel">
              <h2>Dominios</h2>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Dominio</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live_domains.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <span className="mono">{d.host}</span> {d.isPrimary && <Pill tone="accent">Principal</Pill>}
                          {d.status === 'PENDING' && (
                            <div className="muted" style={{ fontSize: '.85rem', marginTop: '.35rem' }}>
                              Crea este registro TXT en el DNS del cliente:
                              <div className="mono" style={{ userSelect: 'all' }}>
                                {verificationRecordName(d.host)} → {verificationRecordValue(d.verificationToken)}
                              </div>
                            </div>
                          )}
                        </td>
                        <td>
                          <DomainStatusPill status={d.status} />
                          {d.verifiedAt && <div className="muted" style={{ fontSize: '.8rem' }}>{formatDate(d.verifiedAt)}</div>}
                        </td>
                        <td>
                          <div className="row">
                            {canWrite && d.status === 'PENDING' && <ActionForm className="inline" action={verifyDnsAction.bind(null, tenant.id, d.id)} submitLabel="Verificar DNS" tone="quiet" />}
                            {can(role, 'domains:verify-manual') && d.status === 'PENDING' && (
                              <ActionForm className="inline" action={verifyManualAction.bind(null, tenant.id, d.id)} submitLabel="Marcar verificado" tone="quiet" confirm="Verificación manual: queda auditada. ¿Seguro?" />
                            )}
                            {canWrite && d.status === 'VERIFIED' && !d.isPrimary && (
                              <ActionForm className="inline" action={setPrimaryAction.bind(null, tenant.id, d.id)} submitLabel="Hacer principal" tone="quiet" />
                            )}
                            {canWrite && !d.isPrimary && (
                              <ActionForm className="inline" action={releaseDomainAction.bind(null, tenant.id, d.id)} submitLabel="Liberar" tone="danger" confirm={`¿Liberar ${d.host}? Queda reservado 30 días para otros clientes.`} />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {released.length > 0 && (
                <p className="muted" style={{ fontSize: '.85rem' }}>
                  Liberados (reservados 30 días): {released.map((d) => d.host).join(', ')}
                </p>
              )}
              {canWrite && (
                <ActionForm className="row" action={addDomainAction.bind(null, tenant.id, sub.id)} submitLabel="Añadir dominio">
                  <input name="host" type="text" required placeholder="otro-dominio.es" autoCapitalize="none" spellCheck={false} aria-label="Nuevo dominio" style={{ maxWidth: '320px' }} />
                </ActionForm>
              )}
            </div>
          </section>
        );
      })}

      <div className="panel">
        <h2>Actividad reciente</h2>
        {audit.length === 0 ? (
          <p className="muted">Sin actividad registrada.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id.toString()}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(a.at)}</td>
                    <td className="mono">{a.action}</td>
                    <td>{a.operatorEmail}</td>
                    <td className="mono muted">{JSON.stringify(a.meta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ margin: '.75rem 0 0' }}>
          <Link href={`/audit?tenant=${tenant.id}`}>Ver todo el registro de este cliente</Link>
        </p>
      </div>
    </main>
  );
}
