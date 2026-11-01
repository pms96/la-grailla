import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* H-086: los botones solo-icono de la puerta no tenían nombre (`aria-label`) y medían 32 px; «Salir» estaba pegado a «Modo noche» y cerraba la sesión de un toque.
 * La puerta se usa de pie, de noche y con prisa: todo botón solo-icono de `app/acceso` debe tener nombre y un objetivo táctil de 44 px (`icon-lg`). */

/** Las etiquetas `<Button …>` de un archivo, con sus atributos (respeta las llaves: una flecha `=>` dentro de `onClick={…}` no cierra la etiqueta). */
function buttonTags(source: string): string[] {
  const tags: string[] = [];
  let i = 0;
  while ((i = source.indexOf('<Button', i)) !== -1) {
    let depth = 0;
    let j = i;
    for (; j < source.length; j += 1) {
      const c = source[j];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0 && source[j - 1] !== '=') break;
    }
    tags.push(source.slice(i, j + 1));
    i = j + 1;
  }
  return tags;
}

const files = () => {
  const dir = path.join(process.cwd(), 'app', 'acceso');
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.tsx')) out.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return out;
};

describe('botones solo-icono de la puerta (H-086)', () => {
  const iconButtons = files().flatMap((f) => buttonTags(fs.readFileSync(f, 'utf8')).filter((t) => /size="icon[^"]*"/.test(t)).map((t) => ({ file: path.relative(process.cwd(), f), tag: t })));

  it('hay botones solo-icono que comprobar (la prueba no es vacua)', () => {
    expect(iconButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('todos tienen aria-label', () => {
    expect(iconButtons.filter(({ tag }) => !/aria-label=/.test(tag)).map(({ file, tag }) => `${file}: ${tag.slice(0, 80)}`)).toEqual([]);
  });

  it('todos miden 44 px (`icon-lg`), no 32 ni 40', () => {
    expect(iconButtons.filter(({ tag }) => !/size="icon-lg"/.test(tag)).map(({ file, tag }) => `${file}: ${tag.slice(0, 80)}`)).toEqual([]);
  });

  it('«Cerrar sesión» pide confirmación antes de salir: el botón del icono no llama a signOut directamente', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'app', 'acceso', '_components', 'access-client.tsx'), 'utf8');
    const logout = buttonTags(src).find((t) => /aria-label="Cerrar sesión"/.test(t))!;
    expect(logout).toBeDefined();
    expect(logout).not.toContain('signOut');
    expect(logout).toContain('setConfirmingExit(true)');
  });
});

// H-103: el botón «Reenviar aviso de envío» no tenía guarda de doble clic y medía 24 px.
describe('pedidos de tienda: reenvío del aviso de envío (H-103)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'app', 'admin', 'pedidos', 'page.tsx'), 'utf8');
  const tag = buttonTags(src).find((t) => t.includes('Reenviar') === false && /resendShipped\(order\.id\)/.test(t));

  it('el botón se desactiva mientras hay un reenvío en curso y no mide 24 px', () => {
    expect(tag).toBeDefined();
    expect(tag).toContain('disabled={resendingShipped !== null}');
    expect(tag).not.toMatch(/h-6\b/);
  });

  it('la función ignora un segundo clic', () => {
    expect(src).toMatch(/if \(resendingShipped\) return;/);
  });
});
