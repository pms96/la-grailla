/* Sondas de la Fase 1 contra la infraestructura real. Solo leen (salvo una clave `__probe__:*` con caducidad en Upstash). Los secretos se
 * pasan por NOMBRE de variable de entorno, nunca por argumento (quedaría en `ps` y en el historial). Sale con 1 si alguna comprobación falla.
 *
 *   npm run infra:probe -- neon     --direct-env NEON_DIRECT [--pooled-env NEON_POOLED] [--cold-start [--idle-seconds 330]]
 *   npm run infra:probe -- registry --url-env UPSTASH_URL --write-token-env UPSTASH_RW --read-token-env UPSTASH_RO
 *   npm run infra:probe -- hosts    --origin https://a.ejemplo.es --origin https://b.ejemplo.es [--region fra1] [--unknown-origin …] [--preview-origin …] [--same-tenant]
 *   npm run infra:probe -- cron     --panel-url https://panel.ejemplo.es --secret-env CRON_SECRET
 *
 * Guía completa y criterios de salida: docs/platform/m8-ensayo.md */
import { formatReport, hasFailures, probeCron, probeDatabase, probeHosts, probeRegistry, type Check } from '../lib/ops/infra-probe';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function values(name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  });
  return out;
}
function value(name: string): string | undefined {
  return values(name)[0];
}
/** El valor de la variable de entorno CUYO NOMBRE se pasó en `--<name>`. */
function envValue(name: string, required = true): string | undefined {
  const varName = value(name);
  if (!varName) {
    if (required) throw new Error(`Falta --${name} <NOMBRE_DE_VARIABLE>`);
    return undefined;
  }
  const v = process.env[varName];
  if (!v) throw new Error(`La variable ${varName} (de --${name}) no está definida`);
  return v;
}

async function main() {
  const secrets: string[] = [];
  const keep = (v: string | undefined) => {
    if (v) secrets.push(v);
    return v;
  };
  let checks: Check[];
  switch (cmd) {
    case 'neon': {
      const idle = flag('cold-start') ? Number(value('idle-seconds') ?? 330) : undefined;
      checks = await probeDatabase({
        directUrl: keep(envValue('direct-env'))!,
        pooledUrl: keep(envValue('pooled-env', false)),
        coldStartIdleSeconds: idle,
      });
      break;
    }
    case 'registry':
      checks = await probeRegistry({
        url: envValue('url-env')!,
        writeToken: keep(envValue('write-token-env'))!,
        readOnlyToken: keep(envValue('read-token-env'))!,
      });
      break;
    case 'hosts': {
      const origins = values('origin');
      if (origins.length < 1) throw new Error('Falta al menos un --origin https://…');
      checks = await probeHosts({
        origins,
        region: value('region'),
        unknownOrigin: value('unknown-origin'),
        previewOrigin: value('preview-origin'),
        sameTenant: flag('same-tenant'),
      });
      break;
    }
    case 'cron': {
      const panelUrl = value('panel-url');
      if (!panelUrl) throw new Error('Falta --panel-url');
      checks = await probeCron({ panelUrl, secret: keep(envValue('secret-env'))! });
      break;
    }
    default:
      throw new Error('Uso: infra:probe <neon|registry|hosts|cron> … (ver la cabecera de scripts/infra-probe.ts)');
  }
  console.log(formatReport(checks, secrets));
  if (hasFailures(checks)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
});
