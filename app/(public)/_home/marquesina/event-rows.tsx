'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import '@/components/templates/marquesina.css';
import type { TemplateEvent } from '../event-view';

const POSTER_OFFSET = 28;
const EDGE = 8;

/**
 * Programación en filas. Con ratón (puntero fino, sin «reducir movimiento») el cartel del evento flota junto al cursor; es decorativo, así que se
 * mueve con un suavizado y nunca es la única forma de ver nada: en táctil cada fila lleva su miniatura, y todo lo importante (fecha, lugar,
 * precio, estado) está en el texto. Los carteles se cargan al pasar por primera vez por su fila, no todos de golpe.
 */
export function EventRows({ events }: { events: readonly TemplateEvent[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [seen, setSeen] = useState<number[]>([]);
  const poster = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });
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

  const draw = () => {
    const el = poster.current;
    if (el) el.style.transform = `translate3d(${current.current.x}px, ${current.current.y}px, 0)`;
  };
  const tick = () => {
    const t = target.current;
    const c = current.current;
    c.x += (t.x - c.x) * 0.18;
    c.y += (t.y - c.y) * 0.18;
    draw();
    if (Math.abs(t.x - c.x) > 0.5 || Math.abs(t.y - c.y) > 0.5) {
      frame.current = requestAnimationFrame(tick);
    } else {
      current.current = { ...t };
      draw();
      frame.current = 0;
    }
  };
  const aim = (e: PointerEvent) => {
    const el = poster.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    // Junto al cursor; si no cabe a la derecha, a la izquierda. Siempre dentro de la pantalla.
    let x = e.clientX + POSTER_OFFSET;
    if (x + w > window.innerWidth - EDGE) x = e.clientX - POSTER_OFFSET - w;
    const y = Math.min(Math.max(e.clientY - h / 2, EDGE), Math.max(EDGE, window.innerHeight - h - EDGE));
    target.current = { x, y };
    if (!frame.current) frame.current = requestAnimationFrame(tick);
  };
  const enter = (i: number, e: PointerEvent) => {
    if (!fine.current || !events[i].imageUrl) {
      setActive(null);
      return;
    }
    aim(e);
    if (active === null) {
      // Primera aparición: sin viaje desde la esquina, el cartel nace junto al cursor.
      current.current = { ...target.current };
      draw();
    }
    setActive(i);
    setSeen((s) => (s.includes(i) ? s : [...s, i]));
  };

  return (
    <>
      <ul className="mq-list" onPointerLeave={() => setActive(null)}>
        {events.map((e, i) => (
          <li key={e.id}>
            <Link
              href={`/eventos/${e.slug}`}
              className="mq-row grid grid-cols-[4rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-5 md:grid-cols-[7rem_minmax(0,1fr)_14rem_9rem_2rem] md:gap-x-8 md:px-8 md:py-7"
              onPointerEnter={(ev) => enter(i, ev)}
              onPointerMove={(ev) => active !== null && aim(ev)}
            >
              <div className="font-display uppercase leading-none">
                <span className="mq-muted block font-mono text-xs tracking-widest">{e.weekday}</span>
                <span className="block text-4xl md:text-6xl">{e.day}</span>
                <span className="mq-muted block font-mono text-xs tracking-widest">{e.month}</span>
              </div>

              <div className="min-w-0">
                <h3 className="mq-row-name font-display text-3xl uppercase leading-[0.92] sm:text-5xl lg:text-6xl">{e.name}</h3>
                <p className="mq-muted mt-2 text-sm md:hidden">{e.place}</p>
                {e.status && (
                  <p className="mt-2 inline-block border border-current px-2 py-0.5 text-xs font-medium uppercase tracking-wide md:hidden">{e.status}</p>
                )}
              </div>

              <p className="mq-muted hidden text-base md:block">{e.place}</p>

              <div className="hidden md:block">
                {e.fromPrice != null && <p className="font-mono text-sm">desde {e.fromPrice.toFixed(2)}€</p>}
                {e.status && <p className="mt-1 inline-block border border-current px-2 py-0.5 text-xs font-medium uppercase tracking-wide">{e.status}</p>}
              </div>

              <ArrowUpRight className="hidden h-6 w-6 md:block" aria-hidden />

              {e.imageUrl ? (
                // img nativo: los carteles pueden ser subidas o URLs externas sin lista de dominios.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={e.imageUrl} alt="" loading="lazy" className="h-14 w-14 object-cover md:hidden" />
              ) : (
                <ArrowUpRight className="h-5 w-5 md:hidden" aria-hidden />
              )}
            </Link>
          </li>
        ))}
      </ul>

      <div ref={poster} className="mq-poster hidden md:block" data-on={active !== null} aria-hidden>
        <div className="mq-poster-card">
          {seen.map((i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={events[i].id} src={events[i].imageUrl ?? ''} alt="" data-active={active === i} />
          ))}
        </div>
      </div>
    </>
  );
}
