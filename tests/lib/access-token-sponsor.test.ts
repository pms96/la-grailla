import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { signSponsorAccess, verifySponsorAccess } from '@/lib/access-token';

describe('access-token — sponsor scope', () => {
  beforeAll(() => {
    if (!process.env.NEXTAUTH_SECRET) {
      process.env.NEXTAUTH_SECRET = 'test-secret-for-access-token-vitest';
    }
  });

  it('firma y verifica un token de sponsor', () => {
    const sponsorId = 'sponsor-test-123';
    const token = signSponsorAccess(sponsorId, 1);
    expect(verifySponsorAccess(sponsorId, 1, token)).toBe(true);
  });

  // AUDIT: el sponsorId de la URL siempre debe contrastarse contra el que
  // firmó el token — un token de otro sponsor no debe dar acceso (IDOR).
  it('rechaza el token de un sponsor distinto', () => {
    const tokenForOther = signSponsorAccess('sponsor-other-456', 1);
    expect(verifySponsorAccess('sponsor-test-123', 1, tokenForOther)).toBe(false);
  });

  it('rechaza un token manipulado o vacío', () => {
    expect(verifySponsorAccess('sponsor-test-123', 1, 'tampered')).toBe(false);
    expect(verifySponsorAccess('sponsor-test-123', 1, null)).toBe(false);
  });

  // AUDIT: regenerar el enlace (incrementar portalTokenVersion) debe invalidar
  // cualquier token firmado con la versión anterior — es la garantía central
  // de la revocación individual del portal de sponsors.
  it('un token de la versión anterior deja de validar tras regenerar', () => {
    const sponsorId = 'sponsor-test-regen';
    const tokenV1 = signSponsorAccess(sponsorId, 1);
    expect(verifySponsorAccess(sponsorId, 1, tokenV1)).toBe(true);
    expect(verifySponsorAccess(sponsorId, 2, tokenV1)).toBe(false);

    const tokenV2 = signSponsorAccess(sponsorId, 2);
    expect(verifySponsorAccess(sponsorId, 2, tokenV2)).toBe(true);
    expect(verifySponsorAccess(sponsorId, 1, tokenV2)).toBe(false);
  });

  // AUDIT: compatibilidad con enlaces ya enviados antes de introducir el
  // versionado (firmados como sign('sponsor', sponsorId), sin versión) —
  // deben seguir validando mientras el sponsor nunca se haya regenerado.
  it('acepta el formato legado (sin versión) solo mientras tokenVersion es 1', () => {
    const sponsorId = 'sponsor-test-legacy';
    const secret = process.env.NEXTAUTH_SECRET!;
    const key = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('la-grailla-access-token-v1'), 32);
    const legacyToken = crypto.createHmac('sha256', Buffer.from(key)).update(`sponsor:${sponsorId}`).digest('base64url').slice(0, 16);

    expect(verifySponsorAccess(sponsorId, 1, legacyToken)).toBe(true);
    expect(verifySponsorAccess(sponsorId, 2, legacyToken)).toBe(false);
  });
});
