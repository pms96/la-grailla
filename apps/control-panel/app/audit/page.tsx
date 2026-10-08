import Link from 'next/link';
import { verifyAuditChain } from '@/lib/audit';
import { requireOperator } from '@/lib/guard';
import { can } from '@/lib/permissions';
import { recentAudit } from '@/lib/queries';
import { Pill, formatDate } from '../_components/ui';

export const dynamic = 'force-dynamic';

export default async function AuditPage({ searchParams }: { searchParams: { tenant?: string; verify?: string } }) {
  const { live } = await requireOperator('view');
  // Recorrer toda la cadena es O(n): solo quien administra el panel puede lanzarlo.
  const canVerify = can(live.operator.role, 'operators:manage');
  const tenantId = searchParams.tenant && /^[0-9A-Z]{26}$/.test(searchParams.tenant) ? searchParams.tenant : undefined;
  const [rows, chain] = await Promise.all([recentAudit({ tenantId, take: 200 }), canVerify && searchParams.verify ? verifyAuditChain() : Promise.resolve(null)]);
  return (
    <main>
      <div className="pagehead">
        <div>
          <h1>Auditoría</h1>
          <p className="muted">
            Registro de solo inserción con cadena de hashes. {tenantId ? 'Filtrado por un cliente. ' : ''}
            {tenantId && <Link href="/audit">Quitar filtro</Link>}
          </p>
        </div>
        {canVerify && <Link href={`/audit?verify=1${tenantId ? `&tenant=${tenantId}` : ''}`}>Verificar integridad de la cadena</Link>}
      </div>
      {chain && (
        <p className={`msg ${chain.ok ? 'ok' : 'error'}`} role="status">
          {chain.ok ? `Cadena íntegra: ${chain.checked} entradas verificadas.` : `La cadena está rota en la entrada ${chain.brokenAtId} (${chain.reason}). Hay manipulación o corrupción.`}
        </p>
      )}
      <div className="panel tablewrap" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Cuándo</th>
              <th>Quién</th>
              <th>Acción</th>
              <th>Objeto</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id.toString()}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(a.at)}</td>
                <td>
                  {a.operatorEmail}
                  {a.ip && <div className="muted mono">{a.ip}</div>}
                </td>
                <td>
                  <Pill tone={a.action.includes('failed') || a.action.includes('locked') ? 'bad' : undefined}>{a.action}</Pill>
                </td>
                <td className="mono">{a.targetType}:{a.targetId.slice(0, 12)}</td>
                <td className="mono muted">{JSON.stringify(a.meta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
