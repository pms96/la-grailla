import { describe, it, expect, beforeAll } from 'vitest';
import { signSponsorAccess, verifySponsorAccess } from '@/lib/access-token';

describe('access-token — sponsor scope', () => {
  beforeAll(() => {
    if (!process.env.NEXTAUTH_SECRET) {
      process.env.NEXTAUTH_SECRET = 'test-secret-for-access-token-vitest';
    }
  });

  it('firma y verifica un token de sponsor', () => {
    const sponsorId = 'sponsor-test-123';
    const token = signSponsorAccess(sponsorId);
    expect(verifySponsorAccess(sponsorId, token)).toBe(true);
  });

  // AUDIT: el sponsorId de la URL siempre debe contrastarse contra el que
  // firmó el token — un token de otro sponsor no debe dar acceso (IDOR).
  it('rechaza el token de un sponsor distinto', () => {
    const tokenForOther = signSponsorAccess('sponsor-other-456');
    expect(verifySponsorAccess('sponsor-test-123', tokenForOther)).toBe(false);
  });

  it('rechaza un token manipulado o vacío', () => {
    expect(verifySponsorAccess('sponsor-test-123', 'tampered')).toBe(false);
    expect(verifySponsorAccess('sponsor-test-123', null)).toBe(false);
  });
});
