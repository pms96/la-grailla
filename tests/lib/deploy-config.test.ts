import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* H-153 (P1-22): `ignore-build.test.ts` prueba la función pura, pero lo que congela de verdad el despliegue es la línea `ignoreCommand` de `vercel.json` y el
 * workflow de smoke: quitar cualquiera de las dos dejaba la suite en verde y la protección sin existir. Aquí se lee la configuración real y se ejecuta el comando
 * tal como lo ejecutaría Vercel. */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('vercel.json: la congelación de despliegues está conectada', () => {
  const config = JSON.parse(read('vercel.json')) as { ignoreCommand?: string };

  it('declara un ignoreCommand', () => {
    expect(typeof config.ignoreCommand).toBe('string');
    expect(config.ignoreCommand!.trim()).not.toBe('');
  });

  it('el ignoreCommand es «node <script>» y el script existe', () => {
    const m = /^node\s+(\S+)$/.exec(config.ignoreCommand!.trim());
    expect(m, `ignoreCommand inesperado: ${config.ignoreCommand}`).not.toBeNull();
    expect(fs.existsSync(path.join(ROOT, m![1])), `no existe ${m![1]}`).toBe(true);
  });

  it('ejecutado tal cual lo ejecuta Vercel: con SALES_FREEZE=1 en producción NO se construye (0); sin él, sí (1)', () => {
    const [bin, ...args] = config.ignoreCommand!.trim().split(/\s+/);
    // «node» de la configuración = el node que ejecuta la prueba (el PATH del entorno de pruebas puede no tenerlo igual).
    const run = (env: Record<string, string>) =>
      spawnSync(bin === 'node' ? process.execPath : bin, args, { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(run({ VERCEL_ENV: 'production', SALES_FREEZE: '1' }).status).toBe(0);
    expect(run({ VERCEL_ENV: 'production' }).status).toBe(1);
    expect(run({ VERCEL_ENV: 'preview', SALES_FREEZE: '1' }).status).toBe(1);
  });
});

describe('post-deploy-smoke.yml: el smoke se dispara tras cada despliegue de producción', () => {
  const wf = read('.github/workflows/post-deploy-smoke.yml');

  it('escucha deployment_status y se puede lanzar a mano', () => {
    expect(wf).toMatch(/^on:\s*\n\s+deployment_status:/m);
    expect(wf).toMatch(/workflow_dispatch:/);
  });

  it('solo comprueba despliegues de producción terminados con éxito (no vistas previas ni fallidos)', () => {
    expect(wf).toMatch(/deployment_status\.state == 'success'/);
    expect(wf).toMatch(/startsWith\(github\.event\.deployment\.environment, 'Production'\)/);
  });

  it('ejecuta el script de smoke, que existe, con las URLs de la variable SMOKE_URLS', () => {
    expect(wf).toMatch(/SMOKE_URLS:\s*\$\{\{\s*vars\.SMOKE_URLS\s*\}\}/);
    expect(wf).toMatch(/scripts\/smoke-check\.ts/);
    expect(fs.existsSync(path.join(ROOT, 'scripts/smoke-check.ts'))).toBe(true);
  });

  it('un lanzamiento manual sin URLs es un error (no un «todo bien» vacío)', () => {
    expect(wf).toMatch(/workflow_dispatch" \] && exit 1/);
  });

  it('declara permisos mínimos (solo lectura)', () => {
    expect(wf).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
  });
});

// H-129 (y H-114 en lo que toca a los workflows de cron): los workflows de GitHub son el disparador de los crons mientras el cliente real siga fuera del panel.
describe('workflows de GitHub: crons y permisos', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const text = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  const crons = files.filter((f) => /^\s*schedule:/m.test(text(f)) && /api\/cron\//.test(text(f)));

  it('hay workflows de cron (si no, este test no demuestra nada)', () => {
    expect(crons.sort()).toEqual(['cleanup-waiting-room.yml', 'reconcile-gateway.yml', 'reconcile-payments.yml']);
  });

  it('TODOS los workflows declaran `permissions` (si no, heredan los permisos por defecto del repositorio)', () => {
    for (const f of files) expect(text(f), f).toMatch(/^permissions:/m);
  });

  it('los de cron no tienen permisos sobre el repositorio, corren de uno en uno, con tope de tiempo y con `curl --max-time`', () => {
    for (const f of crons) {
      const t = text(f);
      expect(t, f).toMatch(/^permissions: \{\}\s*$/m);
      expect(t, f).toMatch(/^concurrency:\s*\n\s+group: \S+\s*\n\s+cancel-in-progress: false/m);
      expect(t, f).toMatch(/timeout-minutes: \d+/);
      expect(t, f).toMatch(/curl [^\n]*--max-time \d+/);
      expect(t, f).toMatch(/--connect-timeout \d+/);
    }
  });

  it('un fallo de la llamada (no responde: 000; o 4xx/5xx) pone el run en rojo, y el 401 dice por qué', () => {
    for (const f of crons) {
      const t = text(f);
      expect(t, f).toMatch(/\|\| status=000/);
      expect(t, f).toMatch(/"\$status" -ge 400/);
      expect(t, f).toMatch(/401[\s\S]*CRON_SECRET no coincide/);
      expect(t, f).toMatch(/exit 1/);
    }
  });

  it('cada cron del front tiene su disparador fuera del panel (la conciliación diaria con la pasarela estaba sin él)', () => {
    const cronRoutes = fs.readdirSync(path.join(ROOT, 'app/api/cron'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(cronRoutes.length).toBeGreaterThanOrEqual(3);
    const all = crons.map(text).join('\n');
    for (const route of cronRoutes) expect(all, route).toContain(`/api/cron/${route}`);
  });
});

// H-128: el preflight del corte no debe exigir lo que `keys:prod` no genera ni dejar mudos los canales de dinero.
describe('platform-preflight: comprobaciones de entorno', () => {
  const pre = read('scripts/platform-preflight.ts');

  it('`CRON_SECRET` solo se exige con --legacy (el cliente legacy la acepta para los workflows de GitHub); si no, un falso «NO hacer el corte»', () => {
    expect(pre).toMatch(/if \(flag\('legacy'\)\) add\('CRON_SECRET/);
    expect(pre).not.toMatch(/^\s*add\('CRON_SECRET/m);
  });

  it('PLATFORM_ALERT_URL y SENTRY_DSN se comprueban como AVISO (⚠) que no bloquea, con la misma regla que el front', () => {
    expect(pre).toMatch(/platformEnvWarnings\(process\.env\)/);
    expect(pre).toMatch(/addWarn\('PLATFORM_ALERT_URL/);
    expect(pre).toMatch(/addWarn\('SENTRY_DSN/);
    expect(pre).toMatch(/failed = checks\.filter\(\(c\) => !c\.ok && !c\.warn\)/); // un aviso no cuenta como fallo
  });
});

