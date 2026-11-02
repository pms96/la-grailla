'use client';

import { useEffect, useRef } from 'react';
import { verdictStyle, verdictWord } from '@/lib/door-verdict-style';

export type VerdictOverlayResult = { result: string; message: string; color: string; ticketType?: string; ticketId?: string };

// H-163: la reentrada autorizada (`REENTRY`, en verde) tiene su icono: sin él caía en el ❌ de «no válida». Lo desconocido sigue siendo ❌.
const ICON: Record<string, string> = { VALID: '✅', REENTRY: '✅', DUPLICATE: '🔁', WRONG_EVENT: '⚠️', ERROR: '⚠️' };

/**
 * Veredicto a pantalla completa (H-085). Antes: texto blanco sobre amarillo/verde (contraste ~2:1), subtexto a 60-80 % de opacidad, y un `div onClick` sin rol,
 * sin anuncio para lector de pantalla y sin teclado. Ahora: colores con contraste ≥ 4,5:1, `role="alert"` (se anuncia al aparecer), el veredicto dicho con palabras
 * (no solo emoji y color) y un botón real «Continuar» que recibe el foco: Enter, Espacio o Escape lo cierran.
 */
export function VerdictOverlay({ result, onDismiss, reentry }: { result: VerdictOverlayResult; onDismiss: () => void; reentry?: { onAllow: () => void } | null }) {
  const style = verdictStyle(result.color);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    buttonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div role="alert" aria-live="assertive" data-verdict={result.result} className="fixed inset-0 z-50 flex items-center justify-center p-8" style={{ backgroundColor: style.bg, color: style.fg }}>
      <div className="text-center max-w-lg">
        <p aria-hidden="true" className="text-4xl md:text-6xl font-display font-bold mb-4">
          {ICON[result.result] ?? '❌'}
        </p>
        <p className="text-sm font-bold uppercase tracking-widest mb-2">{verdictWord(result.result)}</p>
        <p className="text-2xl md:text-4xl font-bold mb-4">{result.message}</p>
        {result.ticketType && <p className="text-lg">Tipo: {result.ticketType}</p>}
        {reentry && (
          <button type="button" className="mt-6 min-h-12 rounded-lg bg-white px-6 py-3 text-lg font-semibold text-black shadow-lg" onClick={reentry.onAllow}>
            Permitir reentrada
          </button>
        )}
        <div className="mt-6">
          <button
            ref={buttonRef}
            type="button"
            onClick={onDismiss}
            className="min-h-12 rounded-lg border-2 px-6 py-3 text-lg font-semibold"
            style={{ borderColor: style.fg, color: style.fg }}
          >
            Continuar
          </button>
        </div>
      </div>
    </div>
  );
}
