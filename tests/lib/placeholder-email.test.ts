import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVITATION_PLACEHOLDER_EMAIL, TAQUILLA_PLACEHOLDER_EMAIL, displayBuyerEmail, isPlaceholderEmail } from '@/lib/placeholder-email';

describe('correos de relleno (H-101)', () => {
  it('reconoce los de relleno, también los antiguos con el nombre de un cliente', () => {
    for (const e of ['taquilla@lagrailla.local', 'invitacion@lagrailla.local', TAQUILLA_PLACEHOLDER_EMAIL, INVITATION_PLACEHOLDER_EMAIL, ' TAQUILLA@X.LOCAL ']) expect(isPlaceholderEmail(e), e).toBe(true);
  });

  it('un correo real no lo es', () => {
    for (const e of ['ana@example.com', 'ana@local.es', 'local@dominio.com', '', null, undefined]) expect(isPlaceholderEmail(e as string), String(e)).toBe(false);
  });

  it('se enseña el canal, no el texto con el nombre de otro cliente', () => {
    expect(displayBuyerEmail('taquilla@lagrailla.local')).toBe('Taquilla (sin correo)');
    expect(displayBuyerEmail('invitacion@lagrailla.local')).toBe('Invitación (sin correo)');
    expect(displayBuyerEmail('otro@algo.local', 'TAQUILLA')).toBe('Taquilla (sin correo)');
    expect(displayBuyerEmail('otro@algo.local', 'INVITATION')).toBe('Invitación (sin correo)');
    expect(displayBuyerEmail('otro@algo.local')).toBe('Sin correo');
    expect(displayBuyerEmail('ana@example.com')).toBe('ana@example.com');
    expect(displayBuyerEmail(null)).toBe('');
  });

  it('el relleno neutro no lleva el nombre de ningún cliente', () => {
    expect(TAQUILLA_PLACEHOLDER_EMAIL).not.toMatch(/grailla/i);
    expect(INVITATION_PLACEHOLDER_EMAIL).not.toMatch(/grailla/i);
  });

  it('las rutas de taquilla e invitaciones guardan el relleno neutro, no «lagrailla.local»', () => {
    for (const rel of ['app/api/taquilla/sale/route.ts', 'app/api/invitations/route.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(src, rel).not.toContain('lagrailla.local');
    }
  });
});
