import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEmailHtml } from '@/lib/tickets';

/* H-231: el email al comprador salía en ASCII sin tildes («Asistentes de 16 y 17 anos», «autorizacion», «Tambien», «codigos»: «anos» no es «años»), y decía «Adjuntamos un PDF con tus
 * entradas» aunque la generación del PDF hubiera fallado (el error se traga y el email sale igualmente). */

const brand = { name: 'X', colors: { emailAccent: '#000', emailTint: '#eee' }, logo: null } as never;
const order = {
  id: 'cabcdefgh0000fp01x7q2m9ka',
  createdAt: new Date('2026-07-15T22:30:00Z'),
  buyerName: 'Ana',
  totalAmount: 20,
  tickets: [],
  event: { name: 'Feria', slug: 'feria', venue: 'Plaza', city: 'Sevilla', date: new Date('2026-09-25T18:00:00Z'), minorAuthorizationEnabled: true },
  vatRate: null,
  channel: 'ONLINE',
} as never;

const html = (attached?: { tickets: boolean; minorAuth: boolean }) => buildEmailHtml(order, 'https://t.test/print', brand, 'https://t.test', 'https://t.test/minor', '', '', attached);

describe('H-231: el email del comprador está en castellano correcto', () => {
  it('lleva tildes y eñes (no «anos», «autorizacion», «Tambien», «codigos», «Confirmacion», «Aqui»)', () => {
    const body = html();
    expect(body).toContain('16 y 17 años');
    expect(body).toContain('autorización');
    expect(body).toContain('También');
    expect(body).toContain('códigos');
    expect(body).toContain('Aquí tienes');
    for (const bad of [' anos', 'autorizacion', 'Tambien', 'codigos', 'Aqui ']) expect(body, bad).not.toContain(bad);
  });

  it('la venta de taquilla (no online) titula «Confirmación de compra», con tilde', () => {
    const taquilla = { ...(order as object), channel: 'TAQUILLA' } as never;
    expect(buildEmailHtml(taquilla, 'https://t.test/print', brand, 'https://t.test')).toContain('Confirmación de compra');
  });

  it('las etiquetas fijas del PDF de autorización de menores (el que se imprime y firma) tampoco van sin tildes', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/minor-authorization-pdf.ts'), 'utf8');
    expect(src).not.toMatch(/\b(anos|autorizacion|acompanados|deberan|Telefono)\b/);
  });
});

describe('H-231: solo dice «adjuntamos un PDF» si el PDF va adjunto', () => {
  it('con el PDF de entradas adjunto (lo normal) lo dice', () => {
    expect(html({ tickets: true, minorAuth: true })).toContain('Adjuntamos un PDF con tus entradas');
  });
  it('sin él (falló la generación) manda abrir el enlace y NO afirma un adjunto', () => {
    const body = html({ tickets: false, minorAuth: true });
    expect(body).not.toContain('Adjuntamos un PDF con tus entradas');
    expect(body).toContain('No hemos podido adjuntar el PDF');
    expect(body).toContain('Ver e imprimir mis entradas');
  });
  it('la autorización de menores solo «va adjunta» si lo va; el enlace de descarga siempre está', () => {
    const sin = html({ tickets: true, minorAuth: false });
    expect(sin).not.toContain('Va adjunta en PDF');
    expect(sin).toContain('https://t.test/minor');
    expect(html({ tickets: true, minorAuth: true })).toContain('Va adjunta en PDF');
  });
});
