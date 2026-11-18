import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* Lote 16 (C): el build del panel NO migra su BD de control. Este workflow manual de GitHub («Run workflow») es la forma de hacerlo sin tener la URL de producción en el portátil. Toca la BD que
 * guarda los secretos y la auditoría del panel, así que lo que importa es lo que NO puede hacer: dispararse solo, escribir en el repositorio, aplicar sin pedirlo, apuntar a una BD local,
 * usar el pooler o dejar la URL en el log. */
const FILE = '.github/workflows/migrate-control-db.yml';
const ROOT = path.resolve(__dirname, '../..');
const exists = fs.existsSync(path.join(ROOT, FILE));
const wf = exists ? fs.readFileSync(path.join(ROOT, FILE), 'utf8') : '';
const stepOf = (name: RegExp) => {
  const blocks = wf.split(/\n(?=      - )/);
  return blocks.find((b) => name.test(b.split('\n')[0] + (b.split('\n')[1] ?? ''))) ?? '';
};

describe('workflow migrate-control-db.yml', () => {
  it('existe y se llama como lo cita el aviso del panel («Migrar la BD de control»)', () => {
    expect(exists).toBe(true);
    expect(wf).toMatch(/^name: Migrar la BD de control\b/m);
    expect(fs.readFileSync(path.join(ROOT, 'apps/control-panel/lib/services/control-schema.ts'), 'utf8')).toContain('«Migrar la BD de control»');
  });

  it('solo se lanza a mano (workflow_dispatch): nunca por push, PR ni calendario', () => {
    expect(wf).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(wf).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|deployment_status|repository_dispatch):/m);
  });

  it('no tiene permisos de escritura sobre el repositorio, corre de uno en uno y con tope de tiempo', () => {
    expect(wf).toMatch(/^permissions:\s*\n\s+contents: read\s*$/m);
    expect(wf).not.toMatch(/(contents|actions|id-token|packages|pull-requests|issues): write/);
    expect(wf).toMatch(/^concurrency:\s*\n\s+group: migrate-control-db\s*\n\s+cancel-in-progress: false/m);
    expect(wf).toMatch(/timeout-minutes: \d+/);
  });

  it('el modo por defecto es «estado» (solo mirar) y «aplicar» hay que elegirlo a propósito', () => {
    expect(wf).toMatch(/modo:[\s\S]*?type: choice[\s\S]*?default: estado[\s\S]*?options:\s*\n\s+- estado\s*\n\s+- aplicar/);
  });

  it('`prisma migrate deploy` solo aparece una vez y solo con modo = aplicar', () => {
    expect(wf.match(/prisma migrate deploy/g)).toHaveLength(1);
    const apply = stepOf(/Aplicar/);
    expect(apply).toMatch(/if: \$\{\{ inputs\.modo == 'aplicar' \}\}/);
    expect(apply).toMatch(/prisma migrate deploy/);
  });

  it('trabaja en el panel y usa la URL DIRECTA del secreto para las dos variables del esquema (nunca el pooler)', () => {
    expect(wf).toMatch(/working-directory: apps\/control-panel/);
    expect([...wf.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(['CONTROL_DIRECT_URL', 'CONTROL_DIRECT_URL']); // solo ese secreto, y solo en las dos variables del esquema
    expect(wf).toMatch(/CONTROL_DIRECT_URL: \$\{\{ secrets\.CONTROL_DIRECT_URL \}\}/);
    expect(wf).toMatch(/CONTROL_DATABASE_URL: \$\{\{ secrets\.CONTROL_DIRECT_URL \}\}/);
    expect(wf).toMatch(/-pooler/); // y lo rechaza
  });

  it('antes de tocar nada comprueba el secreto: falta, localhost o pooler = fallo con motivo', () => {
    const guard = stepOf(/Comprobar/);
    expect(guard).toMatch(/-z "\$CONTROL_DIRECT_URL"/);
    expect(guard).toMatch(/localhost/);
    expect(guard).toMatch(/-pooler/);
    expect((guard.match(/exit 1/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(guard).toMatch(/::error::/);
  });

  it('la URL nunca va al log: toda línea que la imprime pasa por `sed` y GitHub la enmascara como secreto', () => {
    for (const line of wf.split('\n')) {
      if (/echo/.test(line) && /\$\{?CONTROL_DIRECT_URL/.test(line)) expect(line, line).toMatch(/sed/);
    }
    expect(wf).not.toMatch(/set -x|--debug/);
  });

  it('el modo «estado» no falla por tener migraciones pendientes (informa) pero sí si no puede conectar', () => {
    const status = stepOf(/Estado/);
    expect(status).toMatch(/prisma migrate status/);
    expect(status).toMatch(/::notice::|::warning::/);
    expect(status).toMatch(/exit 1/);
  });

  it('instala con `npm ci` del panel y fija las acciones por SHA (H-114)', () => {
    expect(wf).toMatch(/npm ci/);
    for (const m of wf.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) expect(m[1]).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    expect(wf).toMatch(/cache-dependency-path: apps\/control-panel\/package-lock\.json/);
  });
});
