import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { actorFromSession, recordAdminAuditSafe } from '@/lib/admin-audit';
import { temporadaCerrada } from '@/lib/contabilidad/control';

/* Mover un evento, producto, patrocinio o pedido de tienda a otra temporada (H-019). El enlace con la temporada decide de qué libros cuenta su margen: moverlo a
 * o desde una temporada CERRADA cambiaría un resultado ya presentado (423 Locked, igual que los gastos e ingresos de P1-16), y moverlo entre temporadas abiertas
 * queda en la auditoría (`temporada.reassign`: quién, qué, desde y hacia dónde). Dejar el enlace como está no cuenta como mover. */

export type SeasonMove = { block: NextResponse } | { block: null; from: string | null; to: string | null; changed: boolean };
export type SeasonMoveTarget = { session: Parameters<typeof actorFromSession>[0]; request: Request; targetType: 'Event' | 'Product' | 'SponsorRequest' | 'ShopOrder'; targetId: string };

const lockedMessage = (nombre: string) =>
  `La temporada «${nombre}» está cerrada: no se puede mover nada hacia ella ni sacarlo de ella, porque cambiaría su margen. El propietario puede reabrirla indicando el motivo.`;

/**
 * Decide si se puede cambiar el enlace de temporada. `currentSeason` lee la temporada actual de la fila (se llama una vez); `requested` es lo que pide el cliente
 * (`''` y `null` = sin temporada). Con `block` hay que devolver esa respuesta tal cual y no escribir nada.
 */
export async function planSeasonMove(currentSeason: () => Promise<string | null | undefined>, requested: string | null | undefined): Promise<SeasonMove> {
  const to = requested || null;
  const from = (await currentSeason()) ?? null;
  if (from === to) return { block: null, from, to, changed: false };

  if (to) {
    const target = await prisma.temporada.findUnique({ where: { id: to }, select: { nombre: true, status: true } });
    if (!target) return { block: NextResponse.json({ error: 'Temporada no encontrada', code: 'temporada_no_encontrada' }, { status: 404 }) };
    if (temporadaCerrada(target)) return { block: NextResponse.json({ error: lockedMessage(target.nombre), code: 'temporada_cerrada' }, { status: 423 }) };
  }
  if (from) {
    const origin = await prisma.temporada.findUnique({ where: { id: from }, select: { nombre: true, status: true } });
    if (origin && temporadaCerrada(origin)) return { block: NextResponse.json({ error: lockedMessage(origin.nombre), code: 'temporada_cerrada' }, { status: 423 }) };
  }
  return { block: null, from, to, changed: true };
}

/** Deja constancia de un cambio de temporada ya guardado. No hace nada si no hubo cambio. No lanza (el cambio ya está hecho). */
export async function recordSeasonMove(move: SeasonMove | null, target: SeasonMoveTarget): Promise<void> {
  if (!move || move.block || !move.changed) return;
  await recordAdminAuditSafe(actorFromSession(target.session), target.request, {
    action: 'temporada.reassign',
    targetType: target.targetType,
    targetId: target.targetId,
    meta: { from: move.from, to: move.to },
  });
}
