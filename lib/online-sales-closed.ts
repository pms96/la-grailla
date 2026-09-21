// Copys del modo "venta online cerrada" (evento a la venta solo en taquilla).
// El admin puede sobrescribirlos por evento (onlineSalesClosedLabel/Message);
// si los deja vacíos, se usa el texto por defecto de aquí.
export const DEFAULT_ONLINE_SALES_CLOSED_LABEL = 'Solo en taquilla';
export const DEFAULT_ONLINE_SALES_CLOSED_MESSAGE =
  'Entradas online cerradas para este evento — cómpralas en taquilla el día del evento.';

type OnlineSalesClosedEvent = {
  onlineSalesClosed: boolean;
  onlineSalesClosedLabel?: string | null;
  onlineSalesClosedMessage?: string | null;
};

export function getOnlineSalesClosedLabel(event: OnlineSalesClosedEvent): string | null {
  if (!event?.onlineSalesClosed) return null;
  const custom = event.onlineSalesClosedLabel?.trim();
  return custom || DEFAULT_ONLINE_SALES_CLOSED_LABEL;
}

export function getOnlineSalesClosedMessage(event: OnlineSalesClosedEvent): string | null {
  if (!event?.onlineSalesClosed) return null;
  const custom = event.onlineSalesClosedMessage?.trim();
  return custom || DEFAULT_ONLINE_SALES_CLOSED_MESSAGE;
}
