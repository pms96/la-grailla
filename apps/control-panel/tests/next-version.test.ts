import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/* H-107: el panel guarda las URLs de BD de todos los clientes, las claves de firma y el token de Vercel, y se quedó en Next 14 mientras el
 * front subía a 15. Estas pruebas fijan (1) que ambos van en la misma versión de Next y (2) que el código del panel usa las APIs de petición
 * de Next 15 de forma asíncrona (cookies, headers, params, searchParams): en 15 el acceso síncrono ya avisa y en 16 desaparece. */

const PANEL = path.resolve(__dirname, '..');
const ROOT = path.resolve(PANEL, '..', '..');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as { dependencies?: Record<string, string> };

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('H-107: el panel va en la misma versión de Next que el front', () => {
  it('Next del panel = Next del front (exacta, sin rango)', () => {
    const panel = json(path.join(PANEL, 'package.json')).dependencies?.next;
    const front = json(path.join(ROOT, 'package.json')).dependencies?.next;
    expect(panel).toMatch(/^\d+\.\d+\.\d+$/);
    expect(panel).toBe(front);
  });

  it('la versión instalada en el panel es la declarada', () => {
    const declared = json(path.join(PANEL, 'package.json')).dependencies?.next;
    const installed = JSON.parse(readFileSync(path.join(PANEL, 'node_modules/next/package.json'), 'utf8')).version;
    expect(installed).toBe(declared);
  });
});

/** Sustituye los comentarios por espacios (mismos saltos de línea): un comentario que nombra `cookies()` no es una llamada. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));

describe('H-107: APIs de petición de Next 15 siempre con await', () => {
  const files = [...sources(path.join(PANEL, 'app')), ...sources(path.join(PANEL, 'lib')), path.join(PANEL, 'middleware.ts')];

  it('cookies() y headers() nunca se usan sin await', () => {
    const bad: string[] = [];
    for (const f of files) {
      const text = withoutComments(readFileSync(f, 'utf8'));
      for (const m of text.matchAll(/(?<!await\s)(?<![\w.])(cookies|headers|draftMode)\(\)/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        bad.push(`${path.relative(PANEL, f)}:${line} ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no se usa useFormState (renombrado a useActionState en React 19)', () => {
    const bad = files.filter((f) => /\buseFormState\b/.test(withoutComments(readFileSync(f, 'utf8')))).map((f) => path.relative(PANEL, f));
    expect(bad).toEqual([]);
  });

  it('params y searchParams de páginas se declaran como Promise', () => {
    const bad: string[] = [];
    for (const f of files.filter((x) => /[\\/]page\.tsx$/.test(x))) {
      const text = withoutComments(readFileSync(f, 'utf8'));
      for (const m of text.matchAll(/\b(params|searchParams)\s*:\s*(?!Promise<)\{/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        bad.push(`${path.relative(PANEL, f)}:${line} ${m[1]} síncrono`);
      }
    }
    expect(bad).toEqual([]);
  });
});
