import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/* El middleware corre en el runtime edge de Vercel: no puede arrastrar (ni siquiera indirectamente) módulos de Node,
 * Prisma ni `next/headers`. Vitest corre en Node y no lo detecta; `next dev` revienta con un 500 en TODAS las rutas.
 * Este test recorre el grafo de imports locales del middleware y falla si aparece algo prohibido. */

const ROOT = path.resolve(__dirname, '../..');
const FORBIDDEN = [/^node:/, /^(crypto|fs|path|os|child_process|stream|zlib|net|tls|http|https)$/, /^next\/headers$/, /^@prisma\/client$/, /^@vercel\/blob/, /^nodemailer$/, /^bcryptjs$/, /^pdf-lib$/];

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else if (spec === '@grailla/contracts') base = path.join(ROOT, 'packages/contracts/src/index');
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importsOf(file: string): { spec: string; typeOnly: boolean }[] {
  const src = fs.readFileSync(file, 'utf8');
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?([^'"\n;]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[4], typeOnly: Boolean(m[2]) });
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.push({ spec: m[1], typeOnly: false });
  return out;
}

function violations(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const walk = (file: string, trail: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { spec, typeOnly } of importsOf(file)) {
      if (typeOnly) continue; // los imports `import type` se borran al compilar
      if (FORBIDDEN.some((re) => re.test(spec))) found.push(`${[...trail, path.relative(ROOT, file)].join(' → ')} importa "${spec}"`);
      const local = resolveLocal(file, spec);
      if (local) walk(local, [...trail, path.relative(ROOT, file)]);
    }
  };
  walk(entry, []);
  return found;
}

describe('el middleware solo importa código apto para edge', () => {
  it('middleware.ts', () => {
    expect(violations(path.join(ROOT, 'middleware.ts'))).toEqual([]);
  });

  it('el detector funciona: avisa si un módulo edge importa uno de Node', () => {
    // lib/tenant/context.ts importa next/headers y context-verify (node:crypto): si el middleware lo importara, esto lo vería.
    expect(violations(path.join(ROOT, 'lib/tenant/context.ts')).length).toBeGreaterThan(0);
  });
});
