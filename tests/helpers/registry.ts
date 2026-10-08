import {
  CONTRACT_VERSION,
  DB_URL_DIRECT_FIELD,
  DB_URL_POOLED_FIELD,
  generateSigningKeyPair,
  registryKeyForHost,
  registryKeyForSecrets,
  sealSecret,
  signSecretsSnapshot,
  signSnapshot,
  type RoutingRecord,
} from '@grailla/contracts';
import type { RegistryReader } from '@/lib/tenant/resolve';

export class FakeRegistry implements RegistryReader {
  data = new Map<string, string>();
  calls: string[] = [];
  failWith: Error | null = null;
  async get(key: string): Promise<string | null> {
    this.calls.push(key);
    if (this.failWith) throw this.failWith;
    return this.data.get(key) ?? null;
  }
}

export async function makeSigner() {
  const { privateKey, publicKey } = await generateSigningKeyPair();
  return { kid: 't1', privateKey, publicKey };
}
export type Signer = Awaited<ReturnType<typeof makeSigner>>;

export type PublishOptions = {
  tenantId: string;
  hosts: string[];
  product?: string;
  modules?: string[];
  status?: RoutingRecord['status'];
  epoch?: number;
  seq?: number;
  contractVersion?: number;
  /** clave maestra con la que sellar las URLs de BD (kid "tk") */
  master: Uint8Array;
  skipSecrets?: boolean;
  license?: RoutingRecord['license'];
  /** Horas hasta que el snapshot se considera obsoleto (por defecto 168, como en el panel). */
  staleHours?: number;
  now?: number;
};

/** Hace lo mismo que el panel al publicar: un snapshot de enrutado por dominio y uno de secretos por cliente. */
export async function publishTenant(reg: FakeRegistry, signer: Signer, o: PublishOptions) {
  const product = o.product ?? 'grailla';
  const now = o.now ?? Date.now();
  const seq = o.seq ?? 1;
  const record: RoutingRecord = {
    tenantId: o.tenantId,
    product,
    cell: 'shared-1',
    status: o.status ?? 'ACTIVE',
    modules: o.modules ?? [],
    license: o.license ?? { phase: 'ACTIVE', nextPhaseChangeAt: null },
    primaryDomain: o.hosts[0],
    domains: o.hosts,
    schemaVersion: null,
    epoch: o.epoch ?? 0,
  };
  const routing = JSON.stringify(
    await signSnapshot({ contractVersion: o.contractVersion ?? CONTRACT_VERSION, seq, iat: now, staleUntil: now + (o.staleHours ?? 168) * 3_600_000, record }, signer)
  );
  for (const host of o.hosts) reg.data.set(registryKeyForHost(host), routing);
  if (!o.skipSecrets) {
    const secrets = JSON.stringify(
      await signSecretsSnapshot(
        {
          contractVersion: o.contractVersion ?? CONTRACT_VERSION,
          seq,
          iat: now,
          tenantId: o.tenantId,
          product,
          dbUrlPooledEnc: await sealSecret(`postgresql://u:p@db-${o.tenantId}/x`, { kid: 'tk', tenantId: o.tenantId, field: DB_URL_POOLED_FIELD }, o.master),
          dbUrlDirectEnc: await sealSecret(`postgresql://u:p@direct-${o.tenantId}/x`, { kid: 'tk', tenantId: o.tenantId, field: DB_URL_DIRECT_FIELD }, o.master),
        },
        signer
      )
    );
    reg.data.set(registryKeyForSecrets(o.tenantId, product), secrets);
  }
  return { routingRaw: routing };
}
