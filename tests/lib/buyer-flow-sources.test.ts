import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* Ronda 2 de la fase 5, flujo del comprador: invariantes de cableado de los componentes de cliente (no hay un entorno de DOM en la suite; la lógica que sí se puede probar
 * vive en funciones puras de `lib/` con sus propios tests). */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('H-219: el aviso del turno ya usado no afirma una compra que puede no haberse hecho', () => {
  const gate = read('app/(public)/eventos/[slug]/comprar/_components/waiting-room-gate.tsx');
  it('no dice «Ya completaste una compra» (el turno también se gasta al abrir la pasarela y el comprador puede volver sin pagar)', () => {
    expect(gate).not.toContain('Ya completaste una compra');
    expect(gate).toMatch(/Tu turno anterior ya se ha usado/);
  });
});

describe('H-220: las confirmaciones no pierden un pedido bueno ante un fallo transitorio', () => {
  const shop = read('app/(public)/tienda/confirmacion/[orderId]/_components/shop-confirmation-client.tsx');
  const tickets = read('app/(public)/confirmacion/[orderId]/_components/confirmation-client.tsx');

  it('tienda: solo un 4xx de «no existe» es «Pedido no encontrado»; un 429 o 5xx conserva el pedido o ofrece reintentar', () => {
    expect(shop).toContain('orderLoadOutcome(');
    expect(shop).not.toMatch(/if \(!res\.ok\) \{\s*setOrder\(null\);/);
    expect(shop).toContain('Reintentar');
  });

  it('entradas: un fallo del sondeo no sustituye una confirmación ya cargada por el error', () => {
    expect(tickets).toContain('orderLoadOutcome(');
    expect(tickets).not.toMatch(/setFetchFailed\(true\);\s*setOrder\(null\);/);
  });
});

describe('H-228: /comprar no confunde un fallo de BD con «el evento no existe»', () => {
  const page = read('app/(public)/eventos/[slug]/comprar/page.tsx');
  it('la carga del evento usa loadOrFail (un fallo lanza y lo pinta el error de la web, con reintento) en vez de atraparlo y acabar en notFound()', () => {
    expect(page).toContain("loadOrFail('ComprarPage'");
    expect(page).not.toMatch(/catch \(error\) \{\s*console\.error\('\[ComprarPage\]/);
  });
});

describe('H-229: entradas también avisa de un pedido anterior sin confirmar', () => {
  const confirmation = read('app/(public)/confirmacion/[orderId]/_components/confirmation-client.tsx');
  const form = read('app/(public)/eventos/[slug]/comprar/_components/buy-tickets-form.tsx');

  it('la confirmación recuerda el pedido mientras esté PENDING y lo olvida al constar', () => {
    expect(confirmation).toContain('rememberUnconfirmedTicketOrder(');
    expect(confirmation).toContain('clearUnconfirmedTicketOrder(');
  });

  it('el formulario de compra lee el pedido recordado y avisa («no repitas la compra») con un enlace a su estado', () => {
    expect(form).toContain('readUnconfirmedTicketOrder(');
    expect(form).toMatch(/no repitas la compra/i);
  });

  it('el texto del pedido pendiente que tarda ya no invita a cerrar la página sin más: pide no repetir la compra', () => {
    expect(confirmation).not.toContain('cuando se confirme. Puedes cerrar esta página.');
    expect(confirmation).toContain('no repitas la compra, se confirmará sola');
  });
});

describe('H-230: si la cola se activa con la página ya abierta, el formulario recarga y entra en la sala', () => {
  const form = read('app/(public)/eventos/[slug]/comprar/_components/buy-tickets-form.tsx');
  it('ante `queue_required` refresca los datos del evento (los props traen `waitingRoomEnabled` nuevo y el gate hace el join)', () => {
    expect(form).toMatch(/data\?\.code === 'queue_required'/);
  });
});

describe('H-244: lo que `/comprar` manda al navegador y lo que rastrean los buscadores', () => {
  it('/comprar serializa el evento SIN los campos internos (toPublicEvent: umbrales de aforo, avisos y temporada)', () => {
    const page = read('app/(public)/eventos/[slug]/comprar/page.tsx');
    expect(page).toContain('toPublicEvent(');
    expect(page).not.toMatch(/JSON\.parse\(JSON\.stringify\(event\)\)/);
  });

  it('robots no deja rastrear la página transaccional de compra ni el portal de sponsor', () => {
    const robots = read('app/robots.ts');
    expect(robots).toContain("'/eventos/*/comprar'");
    expect(robots).toContain("'/sponsors/portal/'");
  });

  it('la página de compra y el portal del sponsor llevan noindex (el robots.txt no impide indexar una URL enlazada)', () => {
    expect(read('app/(public)/eventos/[slug]/comprar/page.tsx')).toMatch(/robots:\s*\{\s*index:\s*false/);
    expect(read('app/(public)/sponsors/portal/[sponsorId]/page.tsx')).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});

describe('H-245: el flujo de compra se maneja con teclado y se ve en móvil', () => {
  const form = read('app/(public)/eventos/[slug]/comprar/_components/buy-tickets-form.tsx');

  it('el formulario de entradas es un <form> real: Enter y el «Ir» del teclado móvil lo envían, y el botón fijo del móvil lo envía por su id', () => {
    expect(form).toMatch(/<form[^>]*id="buy-tickets-form"[^>]*onSubmit=/);
    expect(form).toMatch(/form="buy-tickets-form"/);
    expect(form).toMatch(/noValidate/); // la validación y sus avisos son los propios (por campo, con foco), no los del navegador
  });

  it('«Ver e imprimir mis entradas» lleva <meta viewport> (sin él sale diminuto en el móvil, la pantalla que más abre el comprador)', () => {
    const route = read('app/api/tickets/[orderId]/pdf-html/route.ts');
    const heads = route.match(/<head>[^`]*<\/head>/g) ?? [];
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) expect(head).toContain('name="viewport"');
  });
});
