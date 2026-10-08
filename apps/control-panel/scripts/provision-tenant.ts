/* Alta de un cliente de punta a punta (idempotente: si se corta, repite el MISMO comando).
 *
 *   npm run tenant:provision -- --name "Bar Pepe" --host www.barpepe.es --modules tienda,entradas \
 *     --admin-email dueno@barpepe.es --legal-dir ./legales/barpepe \
 *     --database-existing --pooled-env BARPEPE_DB_POOLED --direct-env BARPEPE_DB_DIRECT \
 *     [--domain dns|manual|pending] [--admin-name "Pepe"] [--admin-user-email otro@barpepe.es] \
 *     [--config social_instagram=https://…] [--credentials-file ./credenciales.txt] \
 *     [--allow-incomplete] [--no-publish] [--check-health]
 *
 *   --legal-dir  carpeta con aviso-legal.txt, privacidad.txt y cookies.txt (textos del CLIENTE).
 *   --database-existing  usa una BD ya creada (producción: proyecto de Neon del cliente), con las URLs en VARIABLES DE ENTORNO
 *                        cuyo nombre se pasa por argumento (nunca la URL: quedaría en `ps` y en el historial).
 *   --database-local[=nombre]  crea la BD en el Postgres local (solo desarrollo).
 *   La contraseña inicial del administrador se muestra UNA vez (o se guarda en --credentials-file con permisos 0600). */
import fs from 'node:fs';
import path from 'node:path';
import type { ActingOperator } from '../lib/actor';
import { prisma } from '../lib/db';
import { localDatabaseName, provisionTenant, type ProvisionInput } from '../lib/services/provision';

const actor: ActingOperator = { id: 'cli', email: 'alta@servidor', role: 'SUPERADMIN', ip: null, userAgent: 'cli' };

const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1];
}
const flag = (name: string) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const all = (name: string) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : a.startsWith(`--${name}=`) ? [a.slice(name.length + 3)] : []));

function fromEnv(argName: string): string {
  const varName = arg(argName);
  if (!varName) throw new Error(`Falta --${argName} <NOMBRE_DE_VARIABLE>`);
  const value = process.env[varName];
  if (!value) throw new Error(`La variable de entorno ${varName} no está definida`);
  return value;
}

function readLegal(dir: string | undefined): ProvisionInput['legal'] {
  if (!dir) return {};
  const read = (...names: string[]) => {
    for (const n of names) {
      const file = path.join(dir, n);
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    }
    return undefined;
  };
  return {
    legal_notice: read('aviso-legal.txt', 'aviso-legal.md'),
    privacy_policy: read('privacidad.txt', 'privacidad.md'),
    cookies_policy: read('cookies.txt', 'cookies.md'),
  };
}

async function main() {
  const name = arg('name');
  const host = arg('host');
  const adminEmail = arg('admin-email');
  if (!name || !host || !adminEmail) throw new Error('Faltan --name, --host y --admin-email');
  const config = Object.fromEntries(
    all('config').map((kv) => {
      const eq = kv.indexOf('=');
      if (eq < 1) throw new Error(`--config espera CLAVE=valor (recibido: ${kv.split('=')[0]})`);
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    })
  );
  const credentialsFile = arg('credentials-file');
  if (credentialsFile && fs.existsSync(credentialsFile)) throw new Error(`${credentialsFile} ya existe: no se sobrescribe`);

  const input: ProvisionInput = {
    name,
    primaryHost: host,
    productKey: arg('product') ?? 'grailla',
    modules: (arg('modules') ?? '').split(',').map((m) => m.trim()).filter(Boolean),
    adminEmail,
    adminUser: { email: arg('admin-user-email'), name: arg('admin-name') },
    legal: readLegal(arg('legal-dir')),
    config,
    database: flag('database-existing')
      ? { mode: 'existing', pooledUrl: fromEnv('pooled-env'), directUrl: fromEnv('direct-env') }
      : { mode: 'local', name: arg('database-local') || localDatabaseName(name) },
    domain: (arg('domain') as ProvisionInput['domain']) ?? 'pending',
    publish: !flag('no-publish'),
    allowIncomplete: flag('allow-incomplete'),
    dbRegion: arg('region') ?? null,
  };

  const res = await provisionTenant(input, actor, { checkHealth: flag('check-health') });
  const icon = { done: '✓', skipped: '·', blocked: '…', failed: '✗' } as const;
  console.log(`Alta de ${name} (${res.host})`);
  for (const s of res.steps) console.log(`  ${icon[s.status]} ${s.step.padEnd(10)} ${s.detail ?? ''}`);
  if (res.tenantId) console.log(`\n  tenantId: ${res.tenantId}`);
  if (res.dnsRecord) console.log(`  DNS: crea el TXT ${res.dnsRecord.name} = ${res.dnsRecord.value}`);
  if (res.adminPassword) {
    if (credentialsFile) {
      fs.writeFileSync(credentialsFile, `usuario: ${input.adminUser?.email ?? adminEmail}\ncontraseña: ${res.adminPassword}\n`, { mode: 0o600, flag: 'wx' });
      console.log(`  Credenciales iniciales guardadas en ${credentialsFile} (permisos 0600). Entrégalas al cliente y bórralas.`);
    } else {
      console.log(`  Usuario administrador: ${input.adminUser?.email ?? adminEmail}`);
      console.log(`  Contraseña inicial (solo se muestra ahora): ${res.adminPassword}`);
    }
  }
  if (!res.published) console.log('\n  La web NO está publicada todavía (ver los pasos pendientes).');
  if (res.steps.some((s) => s.status === 'failed')) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
