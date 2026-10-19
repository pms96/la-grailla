'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import '@/components/templates/cine.css';

/** Flechas del riel de la cartelera: con ratón y teclado no siempre hay trackpad. Sin JavaScript el riel se desplaza igual (a mano o con el
 *  teclado, porque es una región enfocable); estos botones solo aparecen cuando funcionan. */
export function RailControls({ targetId }: { targetId: string }) {
  const [mounted, setMounted] = useState(false);
  const [edge, setEdge] = useState({ start: true, end: false });

  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;
    const sync = () => setEdge({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
    sync();
    setMounted(true);
    el.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    return () => {
      el.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, [targetId]);

  if (!mounted) return null;
  // El desplazamiento suave respeta «reducir movimiento».
  const go = (dir: -1 | 1) => {
    const el = document.getElementById(targetId);
    if (!el) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: calm ? 'auto' : 'smooth' });
  };

  return (
    <div className="flex gap-2">
      <button type="button" className="cn-ctrl" onClick={() => go(-1)} disabled={edge.start} aria-label="Eventos anteriores" aria-controls={targetId}>
        <ChevronLeft className="h-5 w-5" aria-hidden />
      </button>
      <button type="button" className="cn-ctrl" onClick={() => go(1)} disabled={edge.end} aria-label="Más eventos" aria-controls={targetId}>
        <ChevronRight className="h-5 w-5" aria-hidden />
      </button>
    </div>
  );
}
