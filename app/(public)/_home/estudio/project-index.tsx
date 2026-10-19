'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import '@/components/templates/estudio.css';
import type { SectionItem } from '@/lib/content/sections';

const OFFSET = 28;
const EDGE = 8;

const isExternal = (href: string) => /^https:\/\//i.test(href);

/**
 * Índice de proyectos de la plantilla «estudio». Con ratón (puntero fino, sin «reducir movimiento») la imagen del proyecto aparece junto al
 * cursor con un suavizado; es decorativa y nunca la única forma de ver nada: en táctil cada fila lleva su miniatura y todo lo importante
 * (nombre, dato, descripción, enlace) está en el texto. Las imágenes se piden al pasar por primera vez por su fila, no todas de golpe.
 * Una fila con enlace es un enlace; sin enlace es solo texto (y sigue enseñando su imagen).
 */
export function ProjectIndex({ items }: { items: readonly SectionItem[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [seen, setSeen] = useState<number[]>([]);
  const preview = useRef<HTMLDivElement>(null);
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
    const el = preview.current;
    if (el) el.style.transform = `translate3d(${current.current.x}px, ${current.current.y}px, 0)`;
  };
  const tick = () => {
    const t = target.current;
    const c = current.current;
    c.x += (t.x - c.x) * 0.2;
    c.y += (t.y - c.y) * 0.2;
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
    const el = preview.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    // Junto al cursor; si no cabe a la derecha, a la izquierda. Siempre dentro de la pantalla.
    let x = e.clientX + OFFSET;
    if (x + w > window.innerWidth - EDGE) x = e.clientX - OFFSET - w;
    const y = Math.min(Math.max(e.clientY - h / 2, EDGE), Math.max(EDGE, window.innerHeight - h - EDGE));
    target.current = { x, y };
    if (!frame.current) frame.current = requestAnimationFrame(tick);
  };
  const enter = (i: number, e: PointerEvent) => {
    if (!fine.current || !items[i]?.imageUrl) {
      setActive(null);
      return;
    }
    aim(e);
    if (active === null) {
      // Primera aparición: sin viaje desde la esquina, la imagen nace junto al cursor.
      current.current = { ...target.current };
      draw();
    }
    setActive(i);
    setSeen((s) => (s.includes(i) ? s : [...s, i]));
  };

  const row = (item: SectionItem, i: number): ReactNode => {
    const external = item.href !== '' && isExternal(item.href);
    const body = (
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-6 md:grid-cols-[minmax(0,1fr)_16rem_2rem] md:gap-x-8 md:py-9">
        <div className="min-w-0">
          <h3 className="es-row-title">{item.title}</h3>
          {item.text && <p className="mt-2 line-clamp-2 max-w-xl text-sm text-muted-foreground md:text-base">{item.text}</p>}
          {item.meta && <p className="mt-2 font-mono text-xs uppercase tracking-wider text-muted-foreground md:hidden">{item.meta}</p>}
        </div>
        <p className="hidden font-mono text-xs uppercase tracking-wider text-muted-foreground md:block">{item.meta}</p>
        <div className="flex justify-end">
          {item.imageUrl ? (
            // img nativo: son subidas del cliente a Blob (la CSP ya las admite) y no hay lista de dominios de next/image.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.imageUrl} alt="" loading="lazy" decoding="async" className="h-14 w-14 object-cover md:hidden" />
          ) : null}
          {item.href && <ArrowUpRight className={item.imageUrl ? 'hidden h-6 w-6 md:block' : 'h-5 w-5 md:h-6 md:w-6'} aria-hidden />}
        </div>
        {external && <span className="sr-only">(se abre en otra pestaña)</span>}
      </div>
    );
    const events = { onPointerEnter: (ev: PointerEvent) => enter(i, ev), onPointerMove: (ev: PointerEvent) => active !== null && aim(ev) };
    return item.href ? (
      <a href={item.href} className="es-row" {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} {...events}>
        {body}
      </a>
    ) : (
      <div className="es-row" {...events}>
        {body}
      </div>
    );
  };

  return (
    <>
      <ul className="es-list" onPointerLeave={() => setActive(null)}>
        {items.map((item, i) => (
          <li key={i}>{row(item, i)}</li>
        ))}
      </ul>

      <div ref={preview} className="es-preview hidden md:block" data-on={active !== null} aria-hidden>
        <div className="es-preview-card">
          {seen.map((i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={items[i]?.imageUrl ?? ''} alt="" data-active={active === i} />
          ))}
        </div>
      </div>
    </>
  );
}
