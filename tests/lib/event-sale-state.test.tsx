import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { eventSaleState } from '@/lib/event-sale-state';
import { MobileBuyBar } from '@/app/(public)/eventos/[slug]/_components/mobile-buy-bar';

/* H-156: la ficha «Evento cancelado» sin botón de compra no tenía ningún test: quitar `!eventCancelled` de la ficha o `|| cancelled` de la barra del móvil
 * devolvía el botón «Comprar» en un evento anulado y la suite seguía en verde. */

// `AgeWarningGate` usa el router de la app; en un render estático no hay router montado.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const flags = (over: Partial<Parameters<typeof eventSaleState>[0]> = {}) => ({ cancelled: false, ended: false, taquillaOnly: false, soldOut: false, ...over });

describe('eventSaleState: una sola decisión, con prioridad', () => {
  it('sin ninguna marca, la venta está abierta', () => {
    expect(eventSaleState(flags())).toBe('open');
  });

  it('cada marca cierra la venta por sí sola', () => {
    expect(eventSaleState(flags({ cancelled: true }))).toBe('cancelled');
    expect(eventSaleState(flags({ ended: true }))).toBe('ended');
    expect(eventSaleState(flags({ taquillaOnly: true }))).toBe('taquilla_only');
    expect(eventSaleState(flags({ soldOut: true }))).toBe('sold_out');
  });

  it('un evento cancelado NUNCA está abierto, combine lo que combine (las 16 combinaciones)', () => {
    for (let mask = 0; mask < 16; mask++) {
      const f = { cancelled: Boolean(mask & 1), ended: Boolean(mask & 2), taquillaOnly: Boolean(mask & 4), soldOut: Boolean(mask & 8) };
      const state = eventSaleState(f);
      if (f.cancelled) expect(state, JSON.stringify(f)).toBe('cancelled');
      if (f.cancelled || f.ended || f.taquillaOnly || f.soldOut) expect(state, JSON.stringify(f)).not.toBe('open');
      else expect(state, JSON.stringify(f)).toBe('open');
    }
  });

  it('la prioridad es cancelado > finalizado > solo taquilla > agotado', () => {
    expect(eventSaleState({ cancelled: true, ended: true, taquillaOnly: true, soldOut: true })).toBe('cancelled');
    expect(eventSaleState({ cancelled: false, ended: true, taquillaOnly: true, soldOut: true })).toBe('ended');
    expect(eventSaleState({ cancelled: false, ended: false, taquillaOnly: true, soldOut: true })).toBe('taquilla_only');
    expect(eventSaleState({ cancelled: false, ended: false, taquillaOnly: false, soldOut: true })).toBe('sold_out');
  });
});

describe('MobileBuyBar: la barra del móvil de un evento cancelado', () => {
  const render = (props: Partial<Parameters<typeof MobileBuyBar>[0]> = {}) =>
    renderToStaticMarkup(<MobileBuyBar slug="noche-grande" minPrice={16.5} soldOut={false} {...props} /> as unknown as Parameters<typeof renderToStaticMarkup>[0]);

  it('cancelado: dice «Evento cancelado», no enlaza ni ofrece «Comprar» y manda a otras fechas', () => {
    const html = render({ cancelled: true });
    expect(html).toContain('Evento cancelado');
    expect(html).toContain('Ya no se venden entradas');
    expect(html).not.toContain('noche-grande/comprar');
    expect(html).not.toMatch(/>\s*Comprar\s*</);
    expect(html).toContain('href="/eventos"');
  });

  it('cancelado gana aunque el evento también esté agotado, finalizado o solo en taquilla', () => {
    for (const extra of [{ soldOut: true }, { ended: true }, { taquillaOnly: true }, { soldOut: true, ended: true, taquillaOnly: true }]) {
      const html = render({ cancelled: true, ...extra });
      expect(html, JSON.stringify(extra)).toContain('Evento cancelado');
      expect(html, JSON.stringify(extra)).not.toMatch(/>\s*Comprar\s*</);
    }
  });

  it('abierto: sí hay botón «Comprar» y el precio «Desde»', () => {
    const html = render();
    expect(html).toMatch(/Comprar/);
    expect(html).toContain('16.50€');
    expect(html).not.toContain('Evento cancelado');
  });

  it('cada otro estado cerrado tampoco ofrece «Comprar»', () => {
    for (const extra of [{ soldOut: true }, { ended: true }, { taquillaOnly: true }]) expect(render(extra), JSON.stringify(extra)).not.toMatch(/>\s*Comprar\s*</);
  });
});

describe('ficha del evento: el botón de compra sale de la misma decisión', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'app/(public)/eventos/[slug]/page.tsx'), 'utf8');

  it('la ficha calcula el estado con eventSaleState y le pasa la marca de cancelado', () => {
    expect(page).toMatch(/eventSaleState\(\{[^}]*cancelled:\s*eventCancelled/);
  });

  it('el botón «Comprar entradas» de escritorio solo se pinta con la venta abierta', () => {
    const at = page.indexOf('Comprar entradas');
    expect(at).toBeGreaterThan(0);
    // Lo que abre el bloque que contiene el botón: la condición inmediatamente anterior.
    const before = page.slice(Math.max(0, at - 700), at);
    expect(before).toMatch(/saleState === 'open'/);
  });

  it('la barra del móvil recibe la marca de cancelado', () => {
    expect(page).toMatch(/<MobileBuyBar[\s\S]*cancelled=\{eventCancelled\}/);
  });

  it('la ficha cancelada enseña el aviso con role=status', () => {
    expect(page).toMatch(/\{eventCancelled && \([\s\S]{0,200}role="status"[\s\S]{0,120}EVENT_CANCELLED_NOTICE/);
  });
});
