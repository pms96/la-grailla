/* P0-11 · Condiciones de venta por defecto de entradas y de tienda.
 *
 * BORRADOR ORIENTATIVO: se muestra solo mientras el cliente no escriba las suyas (Configuración → Legal) y está pendiente de revisión por el
 * asesor jurídico (docs/platform/marco-legal.md). No es asesoramiento. Lo que cita (RDL 1/2007, TRLGDCU) conviene que lo confirme el abogado
 * para la actividad concreta de cada cliente. Texto plano: la página lo muestra con saltos de línea. */

export type TermsContext = { name: string; nif?: string; address?: string; email?: string };

const holder = (c: TermsContext) =>
  `${c.name}${c.nif ? `, con NIF ${c.nif}` : ''}${c.address ? ` y domicilio en ${c.address}` : ''}`;
const contact = (c: TermsContext) => (c.email ? ` Puedes escribirnos a ${c.email}.` : '');

export function defaultTermsEntradas(c: TermsContext): string {
  return [
    `1. Quién vende. Las entradas se venden por ${holder(c)}.`,
    `2. Precio. Los precios incluyen el IVA. Si se aplican gastos de distribución, se muestran desglosados antes de pagar.`,
    `3. Pago y entrada. El pago se hace online con tarjeta a través de una pasarela de pago segura. Recibirás las entradas por email cuando el pago se confirme.`,
    `4. Sin derecho de desistimiento. De acuerdo con el artículo 103.l del texto refundido de la Ley General para la Defensa de los Consumidores y Usuarios, el derecho de desistimiento no se aplica a la compra de entradas para actividades de ocio con fecha o periodo de ejecución específicos. Las entradas no se reembolsan, salvo cancelación o aplazamiento del evento.`,
    `5. Cancelación o aplazamiento. Si el evento se cancela, te avisaremos por email y te devolveremos el importe. Si se aplaza, tu entrada seguirá siendo válida para la nueva fecha, o podrás pedir la devolución según te indiquemos en el aviso.`,
    `6. Entrada personal. Cada entrada lleva un código QR de un solo uso. No lo compartas ni lo publiques: quien lo use primero entra. No se permite la reventa.`,
    `7. Edad y acceso. Debes cumplir los requisitos de edad y acceso indicados en la ficha del evento. Podemos denegar la entrada a quien no los cumpla, sin derecho a reembolso.`,
    `8. Reclamaciones. Disponemos de hojas de reclamaciones.${contact(c)}`,
    `9. Datos personales. Tratamos tus datos según nuestra política de privacidad.`,
  ].join('\n\n');
}

export function defaultTermsTienda(c: TermsContext): string {
  return [
    `1. Quién vende. Los productos se venden por ${holder(c)}.`,
    `2. Precio. Los precios incluyen el IVA. Si hay gastos de envío, se indican antes de pagar.`,
    `3. Pago. El pago se hace online con tarjeta a través de una pasarela de pago segura. El pedido se confirma cuando se recibe el pago.`,
    `4. Entrega. Salvo que se indique otra fecha, entregamos el pedido como máximo en 30 días desde la confirmación del pago. Si no podemos, te avisaremos y te devolveremos el importe.`,
    `5. Derecho de desistimiento. Tienes 14 días naturales desde que recibes el pedido para desistir de la compra sin dar explicaciones. Comunícanoslo por email indicando el número de pedido.${contact(c)} Te devolveremos el importe en un máximo de 14 días desde tu comunicación, y puedes devolvernos los productos en ese mismo plazo. Los gastos de devolución corren por tu cuenta salvo que se indique otra cosa.`,
    `6. Excepciones. No hay desistimiento en los productos confeccionados conforme a tus especificaciones o claramente personalizados, ni en los que, por su naturaleza, no se puedan devolver.`,
    `7. Garantía. Los productos tienen la garantía legal de conformidad. Si llega defectuoso o no es lo que pediste, contáctanos.${contact(c)}`,
    `8. Reclamaciones. Disponemos de hojas de reclamaciones.`,
    `9. Datos personales. Tratamos tus datos según nuestra política de privacidad.`,
  ].join('\n\n');
}
