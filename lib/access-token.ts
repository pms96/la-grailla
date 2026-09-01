import crypto from 'crypto';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const HKDF_INFO = 'la-grailla-access-token-v1';
const TOKEN_BYTES = 16;

function accessKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET no está definido — necesario para firmar tokens de acceso');
  }
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(HKDF_INFO), 32)
  );
}

function sign(scope: string, id: string): string {
  return crypto.createHmac('sha256', accessKey()).update(`${scope}:${id}`).digest('base64url').slice(0, TOKEN_BYTES);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Token opaco para acceder a un pedido (PDF, JSON, confirmación). */
export function signOrderAccess(orderId: string): string {
  return sign('order', orderId);
}

export function verifyOrderAccess(orderId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  try {
    return safeEqual(signOrderAccess(orderId), token);
  } catch {
    return false;
  }
}

/** Token para descargar wallet de una entrada concreta. */
export function signTicketAccess(ticketId: string): string {
  return sign('ticket', ticketId);
}

export function verifyTicketAccess(ticketId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  try {
    return safeEqual(signTicketAccess(ticketId), token);
  } catch {
    return false;
  }
}

export function orderAccessQuery(orderId: string): string {
  return `t=${encodeURIComponent(signOrderAccess(orderId))}`;
}

export function ticketAccessQuery(ticketId: string): string {
  return `t=${encodeURIComponent(signTicketAccess(ticketId))}`;
}

export async function isStaffSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  const role = session?.user?.role ?? '';
  return role === 'ADMIN' || role === 'TAQUILLA';
}

/** Token de pedido válido o sesión staff. */
export async function allowOrderAccess(
  orderId: string,
  token: string | null | undefined
): Promise<boolean> {
  if (verifyOrderAccess(orderId, token)) return true;
  return isStaffSession();
}

/** Token de ticket, token del pedido padre, o staff. */
export async function allowTicketAccess(
  ticketId: string,
  orderId: string | null | undefined,
  token: string | null | undefined
): Promise<boolean> {
  if (verifyTicketAccess(ticketId, token)) return true;
  if (orderId && verifyOrderAccess(orderId, token)) return true;
  return isStaffSession();
}

/** Token de acceso al portal de un sponsor (sin cuenta, como los de pedido/ticket). */
export function signSponsorAccess(sponsorId: string): string {
  return sign('sponsor', sponsorId);
}

export function verifySponsorAccess(sponsorId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  try {
    return safeEqual(signSponsorAccess(sponsorId), token);
  } catch {
    return false;
  }
}

export function sponsorAccessQuery(sponsorId: string): string {
  return `t=${encodeURIComponent(signSponsorAccess(sponsorId))}`;
}

/** Token de sponsor válido o sesión de admin (staff revisando el portal). */
export async function allowSponsorAccess(
  sponsorId: string,
  token: string | null | undefined
): Promise<boolean> {
  if (verifySponsorAccess(sponsorId, token)) return true;
  return isStaffSession();
}

export function getTokenFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('t');
  if (fromQuery) return fromQuery;
  const header = request.headers.get('x-access-token');
  return header || null;
}
