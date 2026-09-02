'use client';

import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type CssLength = number | string;
function toCssLength(value: CssLength) {
  return typeof value === 'number' ? `${value}px` : value;
}

// Recorte tipo entrada física: esquinas a elegir + muescas semicirculares en
// el punto donde se "arranca" el talón, calculado con custom properties para
// que la línea discontinua (ver EventTicket) siempre coincida con el corte.
const TICKET_CLIP_PATH = `polygon(
  0 var(--ticket-corner-size),
  var(--ticket-corner-size) 0,
  calc(100% - var(--ticket-corner-size)) 0,
  100% var(--ticket-corner-size),
  100% calc(100% - var(--ticket-stub-height) - var(--ticket-notch-size)),
  calc(100% - var(--ticket-notch-size)) calc(100% - var(--ticket-stub-height)),
  100% calc(100% - var(--ticket-stub-height) + var(--ticket-notch-size)),
  100% calc(100% - var(--ticket-corner-size)),
  calc(100% - var(--ticket-corner-size)) 100%,
  var(--ticket-corner-size) 100%,
  0 calc(100% - var(--ticket-corner-size)),
  0 calc(100% - var(--ticket-stub-height) + var(--ticket-notch-size)),
  var(--ticket-notch-size) calc(100% - var(--ticket-stub-height)),
  0 calc(100% - var(--ticket-stub-height) - var(--ticket-notch-size))
)`;

export const TICKET_BARCODE_BG =
  'repeating-linear-gradient(90deg, currentColor 0 2px, transparent 2px 4px, currentColor 4px 5px, transparent 5px 8px, currentColor 8px 12px, transparent 12px 14px)';

type TicketStyle = CSSProperties & {
  '--ticket-corner-size'?: string;
  '--ticket-notch-size'?: string;
  '--ticket-stub-height'?: string;
};

export function EventTicket({
  body,
  stub,
  className,
  cornerSize = 0,
  notchSize = 10,
  stubHeight = 108,
  'aria-label': ariaLabel,
}: {
  body: ReactNode;
  stub: ReactNode;
  className?: string;
  cornerSize?: CssLength;
  notchSize?: CssLength;
  stubHeight?: CssLength;
  'aria-label'?: string;
}) {
  const style: TicketStyle = {
    '--ticket-corner-size': toCssLength(cornerSize),
    '--ticket-notch-size': toCssLength(notchSize),
    '--ticket-stub-height': toCssLength(stubHeight),
    clipPath: TICKET_CLIP_PATH,
  };

  return (
    <article
      aria-label={ariaLabel}
      style={style}
      className={cn(
        'relative w-full overflow-hidden bg-lima text-[hsl(240_20%_6%)]',
        'shadow-[0_1px_1px_rgb(0_0_0/0.15),0_16px_24px_rgb(0_0_0/0.18)]',
        'transition-transform duration-normal ease-out hover:-translate-y-1',
        className,
      )}
    >
      <div className="relative overflow-hidden px-4 pb-3 pt-4">{body}</div>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-4 z-10 border-t border-dashed border-black/25"
        style={{ bottom: 'var(--ticket-stub-height)' }}
      />
      <div className="relative overflow-hidden px-4 py-3" style={{ height: 'var(--ticket-stub-height)' }}>
        {stub}
      </div>
    </article>
  );
}
