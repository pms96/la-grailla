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
