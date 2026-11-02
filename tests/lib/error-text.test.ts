import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { userMessage } from '@/lib/error-text';

/* H-165 (fase 4): con una respuesta que no es JSON (un 502 de HTML de un proxy caído) `res.json()` lanza un SyntaxError y varias pantallas del admin pintaban su texto
 * tal cual en el aviso: `Unexpected token '<', "<html>…" is not valid JSON`. El usuario no puede hacer nada con eso. */

describe('userMessage', () => {
  it('conserva el mensaje que escribimos nosotros (el error real del servidor)', () => {
    expect(userMessage(new Error('La temporada está cerrada'), 'No se pudo guardar')).toBe('La temporada está cerrada');
  });

  it.each([
    new SyntaxError(`Unexpected token '<', "<html>502" is not valid JSON`),
    new Error('Unexpected end of JSON input'),
    new Error('JSON.parse: unexpected character at line 1 column 1 of the JSON data'),
    new TypeError('Failed to fetch'),
    new TypeError('NetworkError when attempting to fetch resource.'),
    new TypeError('Load failed'),
    new Error('Error'),
    new Error('La respuesta is not valid JSON'), // sin «Unexpected token»: solo la regla de JSON inválido lo coge
    new SyntaxError('algo raro del analizador'), // un SyntaxError es técnico sea cual sea su texto
  ])('un texto técnico (%s) se cambia por el de reserva', (err) => {
    expect(userMessage(err, 'No se pudo guardar')).toBe('No se pudo guardar');
  });

  it('lo que no es un Error, o no trae texto, usa el de reserva', () => {
    expect(userMessage('boom', 'Reserva')).toBe('Reserva');
    expect(userMessage(null, 'Reserva')).toBe('Reserva');
    expect(userMessage(new Error(''), 'Reserva')).toBe('Reserva');
  });
});

describe('H-165: el admin no enseña el message crudo de una excepción', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []));

  it('ningún componente de app/admin pinta `e.message` directamente en un aviso (se usa `userMessage`)', () => {
    // Con o sin paréntesis de más: `toast.error((e instanceof Error ? e.message : '…'))` es el mismo defecto.
    const raw = /(?:toast\.error|setLoadError|setError)\(\s*\(*\s*(?:\w+ instanceof Error(?: && \w+\.message)? \? \w+\.message|\w+\.message\b)/;
    const offenders = walk(path.join(ROOT, 'app/admin')).filter((f) => raw.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
