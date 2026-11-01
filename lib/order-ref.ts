/**
 * Referencia corta de un pedido, la que ve el comprador («escríbenos con tu referencia») y la que usa el vendedor en los avisos.
 *
 * Son los ÚLTIMOS 8 caracteres del id (la parte aleatoria de un cuid). Antes eran los 8 primeros: en un cuid v1 son «c» + 7 caracteres del reloj, de ~36 ms de
 * resolución, así que dos pedidos de la misma ventana compartían referencia y la búsqueda del administrador devolvía los dos (H-136). El buscador de Ventas
 * y de Pedidos de tienda busca el id por subcadena, de modo que una referencia nueva (cola del id) y una antigua (cabeza) encuentran el pedido.
 */
export function orderRef(id: string | null | undefined): string {
  return (id ?? '').slice(-8).toUpperCase();
}
