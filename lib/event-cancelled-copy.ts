/* Textos públicos de un evento CANCELADO (H-099). Antes: `/comprar` daba un 404 genérico (como si el evento no existiera) y la ficha prometía «Quien ya compró recibe un
 * aviso por email», que no es verdad si se desmarcó «Avisar», el email del comprador no es real o el SMTP está caído. Ahora se dice qué pasa y lo que se puede hacer sin prometer
 * un envío que el código no controla. */

export const EVENT_CANCELLED_TITLE = 'Este evento se ha cancelado';

/** La ficha del evento y `/comprar`: ya no se venden entradas y qué hacer si ya se compró (sin prometer un aviso). */
export const EVENT_CANCELLED_NOTICE =
  'Este evento se ha cancelado y ya no se venden entradas. Si ya habías comprado, mira tu correo (también la carpeta de spam) y, si no encuentras nada, escribe al organizador con tu referencia de pedido para saber qué pasa con tu compra.';
