'use client';

import { useEffect, useRef } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import '@/components/templates/drop.css';

/**
 * Marco de la imagen de un producto: con ratón (puntero fino, sin «reducir movimiento») el producto se desplaza hacia el cursor y se acerca un
 * poco. Es decorativo (nada depende de ello): en táctil y con menos movimiento queda quieto. Solo escribe dos variables CSS y un atributo; la
 * imagen y el resto son contenido del servidor que llega como `children`.
 */
export function Tilt({ children, tone, className }: { children: ReactNode; tone?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const fine = useRef(false);

  useEffect(() => {
    const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      fine.current = hover.matches && !calm.matches;
    };
    sync();
    hover.addEventListener('change', sync);
    calm.addEventListener('change', sync);
    return () => {
      hover.removeEventListener('change', sync);
      calm.removeEventListener('change', sync);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const set = (dx: number, dy: number, on: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--dx', dx.toFixed(3));
    el.style.setProperty('--dy', dy.toFixed(3));
    el.dataset.hover = String(on);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!fine.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const dy = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => set(dx, dy, true));
  };

  return (
    <div ref={ref} className={className} data-tone={tone} data-hover="false" onPointerMove={move} onPointerLeave={() => set(0, 0, false)}>
      {children}
    </div>
  );
}
