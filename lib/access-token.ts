import crypto from 'crypto';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getInstallationSecret } from '@/lib/tenant/installation-secret';
import { adminLacksModule } from '@/lib/modules/access';
import { prisma } from '@/lib/prisma';
import type { ModuleKey } from '@grailla/contracts';

/** H-212: días después del evento en los que el enlace de pedido/entrada sigue valiendo (reimprimir, soporte). Pasado el plazo la entrada ya no vale para nada y el enlace deja de abrir el pedido. */
export const ORDER_LINK_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ¿Caducó el enlace de este pedido? Se mira al ABRIR el enlace, no al emitirlo: el token no lleva fecha, así que la regla vale también para los enlaces ya enviados. Un pedido sin
 * evento (o que no existe) no caduca por aquí: eso lo decide quien llama.
 */
export async function orderLinkExpired(orderId: string, now: number = Date.now()): Promise<boolean> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { event: { select: { date: true } } } });
  if (!order?.event) return false;
  return now > order.event.date.getTime() + ORDER_LINK_GRACE_DAYS * DAY_MS;
}

const HKDF_INFO = 'la-grailla-access-token-v1';
const TOKEN_BYTES = 16;

function accessKey(): Buffer {
  // Modo normal: NEXTAUTH_SECRET (idéntico a siempre). Plataforma: el secreto de ESTE cliente.
  const secret = getInstallationSecret('access');
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

/** Token opaco para acceder a un pedido de tienda (JSON de confirmación). */
export function signShopOrderAccess(shopOrderId: string): string {
  return sign('shoporder', shopOrderId);
}

export function verifyShopOrderAccess(shopOrderId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  try {
    return safeEqual(signShopOrderAccess(shopOrderId), token);
  } catch {
    return false;
  }
}

export function shopOrderAccessQuery(shopOrderId: string): string {
  return `t=${encodeURIComponent(signShopOrderAccess(shopOrderId))}`;
}

/** Token de pedido de tienda válido o sesión staff. */
export async function allowShopOrderAccess(
  shopOrderId: string,
  token: string | null | undefined
): Promise<boolean> {
  if (verifyShopOrderAccess(shopOrderId, token)) return true;
  return isStaffSessionFor('tienda');
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

/**
 * Personal (ADMIN o TAQUILLA) que además puede usar el módulo dueño de lo que se pide. Un ADMIN con un rol restringido (p. ej. «Contable») sin ese
 * módulo NO pasa: antes el fallback de «o sesión de personal» le dejaba leer pedidos, PDFs y portales de sponsors de cualquier cliente final (P1-03).
 */
export async function isStaffSessionFor(owner: ModuleKey): Promise<boolean> {
  const session = await getServerSession(authOptions);
  const role = session?.user?.role ?? '';
  if (role !== 'ADMIN' && role !== 'TAQUILLA') return false;
  return !adminLacksModule(session?.user, owner);
}

/** Solo ADMIN con el módulo `owner`: para lo que el personal de puerta (TAQUILLA) no debe ver ni tocar (borradores, sponsors). */
export async function isAdminSessionFor(owner: ModuleKey): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN' && !adminLacksModule(session.user, owner);
}

/** Solo ADMIN: para lo que el personal de puerta (TAQUILLA) no debe ver ni tocar (borradores, sponsors). */
export async function isAdminSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

/** Resultado de abrir un enlace de pedido/entrada. `expired` solo lo recibe quien trae un token VÁLIDO (H-212); quien no, `denied`, sin saber si el pedido existe. */
export type LinkAccess = 'ok' | 'denied' | 'expired';
/** Cuerpo del 410 de un enlace caducado: sin datos del pedido, y con a quién acudir. */
export const LINK_EXPIRED_ERROR = 'Este enlace ha caducado. Si necesitas tu entrada, contacta con la organización del evento.';

/** Token de pedido válido y no caducado, o sesión staff. */
export async function orderAccess(orderId: string, token: string | null | undefined): Promise<LinkAccess> {
  const validToken = verifyOrderAccess(orderId, token);
  if (validToken && !(await orderLinkExpired(orderId))) return 'ok';
  if (await isStaffSessionFor('entradas')) return 'ok';
  return validToken ? 'expired' : 'denied';
}

/** Token de pedido válido y no caducado, o sesión staff. */
export async function allowOrderAccess(
  orderId: string,
  token: string | null | undefined
): Promise<boolean> {
  return (await orderAccess(orderId, token)) === 'ok';
}

/** Token de ticket, token del pedido padre, o un ADMIN con Entradas (la taquilla no: el pase de Wallet lleva el QR). */
export async function ticketAccess(
  ticketId: string,
  orderId: string | null | undefined,
  token: string | null | undefined
): Promise<LinkAccess> {
  const validToken = verifyTicketAccess(ticketId, token) || (!!orderId && verifyOrderAccess(orderId, token));
  if (validToken && !(orderId && (await orderLinkExpired(orderId)))) return 'ok'; // H-212: ni el token de la entrada ni el del pedido valen pasado el plazo
  // H-064: SOLO un ADMIN con Entradas, no «cualquier personal». Esto abre el pase de Wallet, que lleva el QR completo, y la búsqueda de la puerta
  // entrega el `ticketId` de cualquier entrada: con el fallback de personal, quien está en la puerta se llevaba el QR de la entrada de otro.
  if (await isAdminSessionFor('entradas')) return 'ok';
  return validToken ? 'expired' : 'denied';
}

export async function allowTicketAccess(
  ticketId: string,
  orderId: string | null | undefined,
  token: string | null | undefined
): Promise<boolean> {
  return (await ticketAccess(ticketId, orderId, token)) === 'ok';
}

/**
 * Token de acceso al portal de un sponsor (sin cuenta, como los de pedido/ticket),
 * versionado por Sponsor.portalTokenVersion — a diferencia de order/shoporder/ticket,
 * este SÍ se puede revocar individualmente: incrementar la versión invalida
 * cualquier enlace firmado con la versión anterior, sin tocar NEXTAUTH_SECRET.
 */
export function signSponsorAccess(sponsorId: string, tokenVersion: number): string {
  return sign('sponsor', `${sponsorId}:${tokenVersion}`);
}

/**
 * Compatibilidad con enlaces emitidos antes de introducir el versionado (firmados
 * como `sign('sponsor', sponsorId)`, sin versión): mientras el sponsor nunca se
 * haya regenerado (tokenVersion === 1), ese formato legado sigue siendo válido
 * además del nuevo formato versionado — así ningún enlace ya enviado se rompe.
 * En cuanto se regenera (tokenVersion > 1), solo el formato nuevo es válido.
 */
export function verifySponsorAccess(sponsorId: string, tokenVersion: number, token: string | null | undefined): boolean {
  if (!token) return false;
  try {
    if (safeEqual(signSponsorAccess(sponsorId, tokenVersion), token)) return true;
    if (tokenVersion === 1) return safeEqual(sign('sponsor', sponsorId), token);
    return false;
  } catch {
    return false;
  }
}

export function sponsorAccessQuery(sponsorId: string, tokenVersion: number): string {
  return `t=${encodeURIComponent(signSponsorAccess(sponsorId, tokenVersion))}`;
}

/** Token de sponsor válido (con su versión vigente) o sesión de ADMIN. La taquilla no gestiona patrocinios. */
export async function allowSponsorAccess(
  sponsorId: string,
  tokenVersion: number,
  token: string | null | undefined
): Promise<boolean> {
  if (verifySponsorAccess(sponsorId, tokenVersion, token)) return true;
  return isAdminSessionFor('sponsors');
}

export function getTokenFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('t');
  if (fromQuery) return fromQuery;
  const header = request.headers.get('x-access-token');
  return header || null;
}
