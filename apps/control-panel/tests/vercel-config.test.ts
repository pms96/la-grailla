import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TENANT_JOBS } from '@/lib/services/crons';

/* Los crons los dispara Vercel Cron (vercel.json del panel). Si el fichero se desincroniza de la ruta, las tareas dejan de correr SIN error:
 * nadie llamaría al disparador. Y si siguiera el workflow antiguo de GitHub, cada tarea correría dos veces. */

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')) as { regions?: string[]; crons?: { path: string; schedule: string }[] };

describe('vercel.json del panel', () => {
  it('programa el disparador de clientes (cada 5 min) y el refresco diario de snapshots', () => {
    const byJob = new Map((config.crons ?? []).map((c) => [new URL(c.path, 'http://x').searchParams.get('job'), c]));
    expect(byJob.get('tenants')?.schedule).toBe('*/5 * * * *');
    expect(byJob.get('snapshots-refresh')?.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });

  it('todas las rutas apuntan al disparador y las tareas `only` existen', () => {
    for (const c of config.crons ?? []) {
      const u = new URL(c.path, 'http://x');
      expect(u.pathname).toBe('/api/cron/dispatch');
      expect(['tenants', 'snapshots-refresh']).toContain(u.searchParams.get('job'));
      const only = u.searchParams.get('only');
      if (only) expect(Object.keys(TENANT_JOBS)).toContain(only);
      expect(c.schedule.split(' ')).toHaveLength(5);
    }
  });

  it('la ruta del disparador existe', () => {
    expect(fs.existsSync(path.join(root, 'app/api/cron/dispatch/route.ts'))).toBe(true);
  });

  it('las funciones corren en Fráncfort, junto a Neon y Upstash (UE)', () => {
    expect(config.regions).toEqual(['fra1']);
  });

  it('el workflow de GitHub que hacía lo mismo ya no existe (no se dispara dos veces)', () => {
    expect(fs.existsSync(path.resolve(root, '../../.github/workflows/platform-crons.yml'))).toBe(false);
  });
});
