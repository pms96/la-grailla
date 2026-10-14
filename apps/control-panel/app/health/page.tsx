import Link from 'next/link';
import { requireOperator } from '@/lib/guard';
import { can } from '@/lib/permissions';
import { healthOverview, type HealthLevel } from '@/lib/queries';
import { describeChannels } from '@/lib/services/alerts';
import { testAlertAction } from '../actions/alerts';
import { ActionForm } from '../_components/action-form';
import { Pill, formatDate } from '../_components/ui';

export const dynamic = 'force-dynamic';

const TONE: Record<HealthLevel, 'ok' | 'warn' | 'bad' | undefined> = { ok: 'ok', warn: 'warn', bad: 'bad', unknown: undefined };
const LABEL: Record<HealthLevel, string> = { ok: 'Todo bien', warn: 'Atención', bad: 'Falla', unknown: 'Sin datos' };

function ago(d: Date | null): string {
  if (!d) return '—';
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return formatDate(d);
}

export default async function HealthPage() {
  const { live } = await requireOperator('view');
  const canTest = can(live.operator.role, 'tenants:write');
  const channels = describeChannels();
  const rows = await healthOverview();
  const count = (l: HealthLevel) => rows.filter((r) => r.level === l).length;
  return (
    <main>
      <div className="pagehead">
        <div>
          <h1>Salud</h1>
          <p className="muted">
            {rows.length === 0
              ? 'Aún no hay clientes.'
              : `${count('bad')} fallan · ${count('warn')} piden atención · ${count('ok')} bien · ${count('unknown')} sin datos`}
          </p>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="panel tablewrap" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Estado</th>
                <th>Comprobado</th>
                <th>Esquema (BD · registro)</th>
                <th>Tareas</th>
                <th>Última migración</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.subscriptionId}>
                  <td>
                    <Link href={`/tenants/${r.tenantId}`}>
                      <strong>{r.name}</strong>
                    </Link>
                    <div className="muted mono">{r.host ?? 'sin dominio verificado'}</div>
                    {r.version && <div className="muted mono">v {r.version}</div>}
                  </td>
                  <td>
                    <Pill tone={TONE[r.level]}>{LABEL[r.level]}</Pill>
                    {r.problems.map((p) => (
                      <div key={p} className="muted" style={{ fontSize: '.8rem', maxWidth: '28rem' }}>
                        {p}
                      </div>
                    ))}
                  </td>
                  <td>
                    {ago(r.checkedAt)}
                    {r.latencyMs !== null && <div className="muted">{r.latencyMs} ms</div>}
                  </td>
                  <td className="mono" style={{ fontSize: '.8rem' }}>
                    {r.schemaApplied ?? '—'}
                    <div className="muted">{r.schemaDeclared ?? '—'}</div>
                  </td>
                  <td>
                    {r.crons.length === 0 && <span className="muted">—</span>}
                    {r.crons.map((c) => (
                      <div key={c.job} style={{ fontSize: '.8rem' }}>
                        <Pill tone={c.failures === 0 ? 'ok' : c.failures >= 3 ? 'bad' : 'warn'}>{c.job}</Pill> <span className="muted">{ago(c.lastSuccessAt)}</span>
                      </div>
                    ))}
                  </td>
                  <td>
                    {r.lastMigration ? (
                      <>
                        <Pill tone={r.lastMigration.status === 'SUCCEEDED' ? 'ok' : r.lastMigration.status === 'FAILED' ? 'bad' : undefined}>{r.lastMigration.status.toLowerCase()}</Pill>
                        <div className="muted">{formatDate(r.lastMigration.at)}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <div className="pagehead" style={{ marginBottom: '.5rem' }}>
          <h2 style={{ margin: 0 }}>Alertas</h2>
          {channels.webhook || channels.email ? <Pill tone="ok">Con canal de aviso</Pill> : <Pill tone="warn">Sin canal de aviso</Pill>}
        </div>
        <p className="muted">
          El panel avisa cuando una tarea de un cliente falla varias veces seguidas (y cuando se recupera), cuando una web pasa de sana a degradada, cuando falla una migración o al publicar en el registro, y cuando falla el refresco diario. Sin ningún canal, el aviso solo queda en el registro del servidor.
        </p>
        <ul className="steplist">
          <li>{channels.webhook ? '✓' : '✗'} Móvil o chat (ntfy, Slack, Discord): {channels.webhook ? 'configurado' : 'sin configurar (ALERT_WEBHOOK_URL)'}</li>
          <li>
            {channels.email ? '✓' : '✗'} Correo: {channels.email ? 'configurado' : channels.emailNeedsSmtp ? 'falta el SMTP del panel (PANEL_SMTP_*)' : 'sin configurar (ALERT_EMAIL_TO)'}
          </li>
          <li>{channels.heartbeat ? '✓' : '✗'} Latido (avisa si el propio panel o su cron se paran): {channels.heartbeat ? 'configurado' : 'sin configurar (HEARTBEAT_URL)'}</li>
        </ul>
        {canTest && <ActionForm className="inline" action={testAlertAction} submitLabel="Enviar alerta de prueba" tone="quiet" />}
      </div>
    </main>
  );
}
