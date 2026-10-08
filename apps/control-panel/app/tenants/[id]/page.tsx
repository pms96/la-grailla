import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOperator } from '@/lib/guard';
import { can } from '@/lib/permissions';
import { getOperations, getTenantDetail, recentAudit } from '@/lib/queries';
import { verificationRecordName, verificationRecordValue } from '@/lib/services/domains';
import { buildRoutingRecord } from '@/lib/services/snapshot';
import { licenseStateOf } from '@/lib/services/license';
import {
  addDomainAction,
  bumpEpochAction,
  emergencyRevokeAction,
  liftRevocationAction,
  redeemKeyAction,
  registerPaymentAction,
  setLicenseAction,
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
import { DomainStatusPill, LicensePhasePill, Pill, PublishPill, TenantStatusPill, formatDate, formatDay } from '../../_components/ui';

export const dynamic = 'force-dynamic';

/** `yyyy-mm-dd` del día de Madrid (el formulario edita el día de cobertura tal como lo ve el operador, no el UTC). */
const madridDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);

export default async function TenantPage({ params }: { params: { id: string } }) {
  const { live } = await requireOperator('view');
  const role = live.operator.role;
  const detail = await getTenantDetail(params.id);
  if (!detail) notFound();
  const { tenant, subscriptions } = detail;
  const audit = await recentAudit({ tenantId: tenant.id, take: 15 });
  const ops = new Map(await Promise.all(subscriptions.map(async ({ sub }) => [sub.id, await getOperations(sub.id)] as const)));
  const canWrite = can(role, 'tenants:write');
  const canBill = can(role, 'billing:write');
  const canRevoke = can(role, 'tenants:revoke');

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

      {tenant.emergencyRevokedAt && (
        <p className="msg error" role="alert">
          Acceso REVOCADO de emergencia desde el {formatDate(tenant.emergencyRevokedAt)}: la web de este cliente está cortada (los webhooks y crons siguen entrando).
        </p>
      )}

      {subscriptions.map(({ sub, pending }) => {
        const license = licenseStateOf(sub);
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

            <div className="panel">
              <div className="pagehead" style={{ marginBottom: '.5rem' }}>
                <h2 style={{ margin: 0 }}>Licencia</h2>
                <LicensePhasePill phase={license.phase} />
              </div>
              <dl className="kv">
                <dt>Cubierto hasta</dt>
                <dd>{sub.paidThrough ? formatDay(sub.paidThrough) : 'Sin caducidad'}</dd>
                <dt>Plazos</dt>
                <dd>
                  {sub.graceDays} días de aviso · {sub.panelBlockedDays} con el panel bloqueado · bloqueo total a los {sub.graceDays + sub.panelBlockedDays} días
                </dd>
                {license.nextPhaseChangeAt && (
                  <>
                    <dt>Próximo cambio</dt>
                    <dd>{formatDay(license.nextPhaseChangeAt)} → {license.schedule[0].phase === 'GRACE' ? 'aviso' : license.schedule[0].phase === 'PANEL_BLOCKED' ? 'panel bloqueado' : 'bloqueo total'}</dd>
                  </>
                )}
              </dl>
              <p className="muted" style={{ fontSize: '.85rem' }}>
                La fase avanza sola en la web del cliente siempre que el panel refresque los snapshots a diario (<span className="mono">npm run snapshots:refresh</span>).
              </p>
              {canBill && (
                <div className="grid2">
                  <ActionForm action={registerPaymentAction.bind(null, tenant.id, sub.id)} submitLabel="Registrar pago">
                    <label>
                      Alargar la cobertura (días)
                      <input name="days" type="number" min={1} max={1100} defaultValue={365} required />
                    </label>
                  </ActionForm>
                  <ActionForm action={redeemKeyAction.bind(null, tenant.id, sub.id)} submitLabel="Canjear clave">
                    <label>
                      Clave de licencia
                      <input name="code" type="text" autoComplete="off" spellCheck={false} placeholder="LGR-XXXXX-XXXXX-XXXXX-XXXXX" required />
                    </label>
                  </ActionForm>
                </div>
              )}
              {canBill && (
                <details style={{ marginTop: '.75rem' }}>
                  <summary>Cambiar fecha y plazos</summary>
                  <ActionForm action={setLicenseAction.bind(null, tenant.id, sub.id)} submitLabel="Guardar licencia" confirm="Si la fecha ya ha pasado, el cliente entrará en aviso o bloqueo en cuanto se publique. ¿Guardar?">
                    <label>
                      Cubierto hasta (vacío = sin caducidad)
                      <input name="paidThrough" type="date" defaultValue={sub.paidThrough ? madridDay(sub.paidThrough) : ''} />
                    </label>
                    <label>
                      Días de aviso
                      <input name="graceDays" type="number" min={0} max={90} defaultValue={sub.graceDays} required />
                    </label>
                    <label>
                      Días más con el panel bloqueado
                      <input name="panelBlockedDays" type="number" min={0} max={180} defaultValue={sub.panelBlockedDays} required />
                    </label>
                  </ActionForm>
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

            {(() => {
              const o = ops.get(sub.id)!;
              return (
                <div className="panel">
                  <h2>Operación</h2>
                  <dl className="kv">
                    <dt>Salud</dt>
                    <dd>
                      {o.health ? (
                        <>
                          <Pill tone={o.health.ok ? 'ok' : o.health.status === 'degraded' ? 'warn' : 'bad'}>{o.health.status}</Pill>{' '}
                          <span className="muted">
                            {formatDate(o.health.checkedAt)}
                            {o.health.latencyMs !== null && ` · ${o.health.latencyMs} ms`}
                            {o.health.version && ` · v ${o.health.version}`}
                          </span>
                          {o.health.error && <div className="muted">{o.health.error}</div>}
                        </>
                      ) : (
                        <span className="muted">sin comprobar</span>
                      )}
                    </dd>
                    {o.crons.map((c) => (
                      <div key={c.job} style={{ display: 'contents' }}>
                        <dt>{c.job}</dt>
                        <dd>
                          <Pill tone={c.consecutiveFailures === 0 ? 'ok' : c.consecutiveFailures >= 3 ? 'bad' : 'warn'}>{c.lastStatus ?? 'pendiente'}</Pill>{' '}
                          <span className="muted">
                            último éxito {formatDate(c.lastSuccessAt)} · próxima {formatDate(c.nextRunAt)}
                            {c.lastError && ` · ${c.lastError}`}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {o.runs.length > 0 && (
                    <details style={{ marginTop: '.75rem' }}>
                      <summary>Últimas migraciones</summary>
                      <ul className="muted" style={{ margin: '.5rem 0 0', paddingLeft: '1.1rem' }}>
                        {o.runs.map((r) => (
                          <li key={r.id}>
                            {formatDate(r.startedAt)} · <strong>{r.status.toLowerCase()}</strong>
                            {r.dryRun ? ' (simulada)' : ''} · {r.fromVersion ?? '∅'} → {r.toVersion ?? '∅'}
                            {r.error && <div>{r.error.split('\n')[0]}</div>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              );
            })()}

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

      {canRevoke && (
        <div className="panel">
          <h2>Emergencia</h2>
          <p className="muted">
            Corta la web de este cliente en unos segundos, sin publicar y aunque este panel falle después. No toca webhooks de pago ni crons.
          </p>
          {tenant.emergencyRevokedAt ? (
            <ActionForm className="inline" action={liftRevocationAction.bind(null, tenant.id)} submitLabel="Levantar la revocación" tone="quiet" />
          ) : (
            <ActionForm className="inline" action={emergencyRevokeAction.bind(null, tenant.id)} submitLabel="Revocar acceso ahora" tone="danger" confirm="Esto corta la web de este cliente en segundos. ¿Seguro?" />
          )}
        </div>
      )}

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
