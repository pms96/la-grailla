/* El cartel crece de la tarjeta a la ficha del evento: una View Transition entre DOCUMENTOS (el navegador anima el elemento que tiene el mismo
 * `view-transition-name` en la página de origen y en la de destino). Funciona con enlaces normales, no con la navegación interna de Next, así que
 * las tarjetas de «cine» son enlaces <a>. En navegadores que no la soportan (o con «reducir movimiento») simplemente se navega como siempre.
 *
 * `@view-transition` es una regla global del documento y no se puede acotar con un selector, así que solo se emite en las páginas de «cine»
 * (un <style> en la propia página): un cliente con otra plantilla nunca la recibe. */

const CSS = `@view-transition{navigation:auto}
::view-transition-group(*){animation-duration:450ms;animation-timing-function:var(--ease-out,cubic-bezier(.23,1,.32,1))}
::view-transition-old(root),::view-transition-new(root){animation-duration:220ms}
@media (prefers-reduced-motion:reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation-duration:.01ms}}`;

/** Nombre de transición del cartel de un evento: el mismo en la tarjeta y en la ficha. Siempre un identificador CSS válido (empieza por letra). */
export function posterTransitionName(slug: string): string {
  return `cn-poster-${slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

export function CineTransitions() {
  // Texto fijo de este archivo (nada del cliente): no hay inyección posible.
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}
