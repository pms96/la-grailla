import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/* Controles de contabilidad (P1-16): temporada cerrada y motivo obligatorio para anular, cerrar o reabrir.
 *
 * - Una temporada CERRADA no admite altas, cambios ni anulaciones de gastos e ingresos (423 Locked). Solo el propietario puede reabrirla, con motivo.
 * - La venta online (pedidos de entradas y de tienda) NO se bloquea con el cierre: el cierre protege los libros ya presentados, no el negocio. */

export const MOTIVO_MIN = 5;
export const MOTIVO_MAX = 300;

export type Motivo = { ok: true; motivo: string } | { ok: false; error: string };

/** Valida el motivo de una anulación, cierre o reapertura. Pura. */
export function parseMotivo(raw: unknown): Motivo {
  const motivo = typeof raw === 'string' ? raw.trim() : '';
  if (motivo.length < MOTIVO_MIN) return { ok: false, error: `Indica el motivo (al menos ${MOTIVO_MIN} caracteres)` };
  if (motivo.length > MOTIVO_MAX) return { ok: false, error: `El motivo no puede pasar de ${MOTIVO_MAX} caracteres` };
  return { ok: true, motivo };
}

export function temporadaCerrada(t: { status: string } | null | undefined): boolean {
  return t?.status === 'CERRADA';
}

export type TemporadaCheck = { ok: true } | { ok: false; status: 404 | 423; error: string; code: 'temporada_no_encontrada' | 'temporada_cerrada' };

function checkOf(t: { nombre: string; status: string } | null | undefined): TemporadaCheck {
  if (!t) return { ok: false, status: 404, error: 'Temporada no encontrada', code: 'temporada_no_encontrada' };
  if (temporadaCerrada(t)) {
    return {
      ok: false,
      status: 423,
      error: `La temporada «${t.nombre}» está cerrada: no se pueden crear, cambiar ni anular gastos o ingresos. El propietario puede reabrirla indicando el motivo.`,
      code: 'temporada_cerrada',
    };
  }
  return { ok: true };
}

/** ¿Se puede escribir en los libros de esta temporada? 404 si no existe, 423 si está cerrada. Lectura suelta: para decidir antes de abrir la transacción. */
export async function checkTemporadaAbierta(temporadaId: string): Promise<TemporadaCheck> {
  return checkOf(await prisma.temporada.findUnique({ where: { id: temporadaId }, select: { nombre: true, status: true } }));
}

/**
 * La misma comprobación DENTRO de la transacción de la escritura y con la fila de la temporada bloqueada (`FOR SHARE`) hasta que ésta termine (H-014).
 * Con la lectura suelta de arriba, un cierre que llegaba entre la comprobación y el INSERT dejaba un apunte nuevo en unos libros ya cerrados:
 * ahora un cierre en curso hace esperar a la escritura (y ésta ve la temporada cerrada → 423), y una escritura en curso hace esperar al cierre.
 */
export async function checkTemporadaAbiertaTx(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, temporadaId: string): Promise<TemporadaCheck> {
  const rows = await tx.$queryRaw<{ nombre: string; status: string }[]>`SELECT "nombre", "status"::text AS "status" FROM "Temporada" WHERE "id" = ${temporadaId} FOR SHARE`;
  return checkOf(rows[0]);
}
