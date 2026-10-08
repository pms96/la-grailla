/* «Salir a producción» de un cliente ya dado de alta: comprueba sus datos mínimos en SU BD, verifica el dominio y publica.
 *
 *   npm run tenant:go-live -- --subscription <id> [--domain dns|manual] [--no-publish] */
import type { ActingOperator } from '../lib/actor';
import { prisma } from '../lib/db';
import { goLiveTenant } from '../lib/services/provision';

const actor: ActingOperator = { id: 'cli', email: 'alta@servidor', role: 'SUPERADMIN', ip: null, userAgent: 'cli' };
const argv = process.argv.slice(2);
const arg = (n: string) => argv[argv.indexOf(`--${n}`) + 1] && argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined;

async function main() {
  const subscription = arg('subscription');
  if (!subscription) throw new Error('Falta --subscription <id>');
  const res = await goLiveTenant(subscription, { domain: (arg('domain') as 'dns' | 'manual' | undefined) ?? 'dns', publish: !argv.includes('--no-publish') }, actor);
  const icon = { done: '✓', skipped: '·', blocked: '…', failed: '✗' } as const;
  for (const s of res.steps) console.log(`  ${icon[s.status]} ${s.step.padEnd(10)} ${s.detail ?? ''}`);
  if (res.dnsRecord) console.log(`  DNS: crea el TXT ${res.dnsRecord.name} = ${res.dnsRecord.value}`);
  if (!res.published) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
