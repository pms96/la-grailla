/* Registra un cliente existente (p. ej. La Grailla como tenant "legacy") desde la consola.
 * Las URLs de su BD se leen de VARIABLES DE ENTORNO cuyo nombre se pasa por argumento: nunca
 * como argumento (quedaría en el historial de la shell y en `ps`).
 *
 *   LAGRAILLA_DB_POOLED=... LAGRAILLA_DB_DIRECT=... \
 *   npm run tenant:register -- --name "La Grailla" --host www.lagrailla.es \
 *     --modules tienda,entradas,contabilidad,wallets,sponsors \
 *     --pooled-env LAGRAILLA_DB_POOLED --direct-env LAGRAILLA_DB_DIRECT \
 *     [--schema-version 2026..._nombre] [--region aws-eu-central-1] [--verified] [--publish]
 *
 * --verified marca el dominio como verificado (el que ejecuta esto tiene acceso al servidor);
 * --publish firma y escribe el snapshot en el almacén configurado (REGISTRY_STORE). */
import type { ActingOperator } from '../lib/actor';
import { prisma } from '../lib/db';
import { verifyDomainManually } from '../lib/services/domains';
import { publishSubscription } from '../lib/services/snapshot';
import { createTenant } from '../lib/services/tenants';

const actor: ActingOperator = { id: 'cli', email: 'cli@servidor', role: 'SUPERADMIN', ip: null, userAgent: 'cli' };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fromEnv(argName: string): string {
  const varName = arg(argName);
  if (!varName) throw new Error(`Falta --${argName} <NOMBRE_DE_VARIABLE>`);
  const value = process.env[varName];
  if (!value) throw new Error(`La variable de entorno ${varName} no está definida`);
  return value;
}

async function main() {
  const name = arg('name');
  const host = arg('host');
  if (!name || !host) throw new Error('Faltan --name y --host');
  const modules = (arg('modules') ?? '').split(',').map((m) => m.trim()).filter(Boolean);

  const { tenant, subscription, domain } = await createTenant(
    {
      name,
      productKey: arg('product') ?? 'grailla',
      primaryHost: host,
      modules,
      dbUrlPooled: fromEnv('pooled-env'),
      dbUrlDirect: fromEnv('direct-env'),
      schemaVersion: arg('schema-version') ?? null,
      dbRegion: arg('region') ?? null,
    },
    actor
  );
  console.log(`Cliente creado: ${tenant.name}`);
  console.log(`  tenantId: ${tenant.id}`);
  console.log(`  módulos : ${modules.length ? modules.join(', ') : '(solo núcleo)'}`);

  if (flag('verified')) {
    await verifyDomainManually(domain.id, actor);
    console.log(`  dominio : ${domain.host} (verificado)`);
  } else {
    console.log(`  dominio : ${domain.host} (pendiente) → TXT _grailla-verify.${domain.host} = grailla-verify=${domain.verificationToken}`);
  }
  if (flag('publish')) {
    const res = await publishSubscription(subscription.id, actor);
    console.log(`  publicado: versión ${res.seq} en ${res.hosts.join(', ')}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
