import { describe, it, expect, beforeAll } from 'vitest';
import {
  signOrderAccess,
  verifyOrderAccess,
  signTicketAccess,
  verifyTicketAccess,
} from '@/lib/access-token';

describe('access-token', () => {
  beforeAll(() => {
    if (!process.env.NEXTAUTH_SECRET) {
      process.env.NEXTAUTH_SECRET = 'test-secret-for-access-token-vitest';
    }
  });

  it('firma y verifica un token de pedido', () => {
    const orderId = 'clxyz_order_123';
    const token = signOrderAccess(orderId);
    expect(token.length).toBeGreaterThan(8);
    expect(verifyOrderAccess(orderId, token)).toBe(true);
    expect(verifyOrderAccess(orderId, 'tampered')).toBe(false);
    expect(verifyOrderAccess('other-id', token)).toBe(false);
    expect(verifyOrderAccess(orderId, null)).toBe(false);
  });

  it('firma y verifica un token de ticket distinto del de pedido', () => {
    const ticketId = 'clxyz_ticket_456';
    const orderId = 'clxyz_order_123';
    const ticketToken = signTicketAccess(ticketId);
    const orderToken = signOrderAccess(orderId);
    expect(verifyTicketAccess(ticketId, ticketToken)).toBe(true);
    expect(verifyTicketAccess(ticketId, orderToken)).toBe(false);
  });
});
