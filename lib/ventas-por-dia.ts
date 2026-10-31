const MADRID_TZ = 'Europe/Madrid';

export type VentasBucketKey = 'online' | 'taquillaTarjeta' | 'taquillaEfectivo' | 'gratis';

export const VENTAS_BUCKET_KEYS: VentasBucketKey[] = ['online', 'taquillaTarjeta', 'taquillaEfectivo', 'gratis'];

export type VentasBucket = { importe: number; entradas: number; pedidos: number };

export type VentasDia = Record<VentasBucketKey, VentasBucket> & {
  fecha: string;
  total: VentasBucket;
  // Caja manual (concepto "Entradas" en /admin/ingresos). null si no hay
  // nada registrado ese día, o si se filtra por evento (la caja no se
  // registra por evento, así que compararla sería engañoso).
  cajaEntradas: number | null;
  // cajaEntradas − efectivo vendido en taquilla según el sistema.
  diferenciaCaja: number | null;
};

export type OrderForVentas = {
  createdAt: Date;
  totalAmount: number;
  channel: string;
  paymentMethod: string;
  tickets: number;
};

export type IngresoForVentas = { fecha: Date; concepto: string; importe: number };

const round2 = (n: number) => Math.round(n * 100) / 100;
const emptyBucket = (): VentasBucket => ({ importe: 0, entradas: 0, pedidos: 0 });

// Cada pedido cae en exactamente un bucket. Invitaciones y pedidos gratis van
// juntos: no mueven dinero, solo cuentan entradas.
export function classifyOrder(order: Pick<OrderForVentas, 'channel' | 'paymentMethod'>): VentasBucketKey {
  if (order.channel === 'INVITACION' || order.paymentMethod === 'FREE') return 'gratis';
  if (order.channel === 'TAQUILLA') return order.paymentMethod === 'CASH' ? 'taquillaEfectivo' : 'taquillaTarjeta';
  return 'online';
}

// Día natural en hora de Madrid ("YYYY-MM-DD"). Agrupar por UTC cortaba mal
// las ventas de madrugada: un pedido a las 00:30 en Madrid caía en el día anterior.
export function madridDayKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: MADRID_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Hora de corte máxima de la jornada de negocio (de 0 a 12 h, hora de Madrid). */
export const JORNADA_CORTE_MAX = 12;

/**
 * Hora de corte válida: un entero de 0 a 12; cualquier otra cosa (vacío, texto, fuera de rango) es 0 = día natural. Se usa con lo que llega de la
 * configuración, que es texto libre: un valor roto nunca debe mover los números de la caja de nadie.
 */
export function parseJornadaCorte(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d{1,2}\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= JORNADA_CORTE_MAX ? n : 0;
}

/**
 * Jornada de negocio (`YYYY-MM-DD`, hora de Madrid) a la que pertenece un instante, con una hora de corte. Con corte 0 es el día natural; con corte 6, la
 * jornada del sábado va desde el sábado a las 06:00 hasta el domingo a las 06:00, así que una noche de 22:00 a 04:00 queda ENTERA en el sábado y se
 * compara con la caja que se anota ese día (antes, la mitad caía en cada día y `diferenciaCaja` salía descuadrada dos días seguidos).
 * El corte se resta en milisegundos reales: el día del cambio horario no tiene 24 h y la jornada de ese día mide 23 o 25, igual que su día natural.
 */
export function businessDayKey(date: Date, cutoffHour = 0): string {
  return madridDayKey(cutoffHour === 0 ? date : new Date(date.getTime() - cutoffHour * 3_600_000));
}

function madridOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MADRID_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// Instante (UTC) en el que empieza ese día en Madrid. Respeta el cambio
// horario: el día del cambio dura 23 o 25 horas.
export function madridDayStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const firstOffset = madridOffsetMinutes(new Date(guess));
  let ms = guess - firstOffset * 60000;
  const secondOffset = madridOffsetMinutes(new Date(ms));
  if (secondOffset !== firstOffset) ms = guess - secondOffset * 60000;
  return new Date(ms);
}

/**
 * Instante en el que EMPIEZA una jornada de negocio. Es la inversa exacta de `businessDayKey`: `businessDayKey(t, c) === d` si y solo si
 * `businessDayStart(d, c) <= t < businessDayStart(addDays(d, 1), c)`. Por eso el filtro de fechas y la agrupación nunca discrepan.
 */
export function businessDayStart(day: string, cutoffHour = 0): Date {
  return new Date(madridDayStart(day).getTime() + cutoffHour * 3_600_000);
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function emptyDia(fecha: string): VentasDia {
  return {
    fecha,
    online: emptyBucket(),
    taquillaTarjeta: emptyBucket(),
    taquillaEfectivo: emptyBucket(),
    gratis: emptyBucket(),
    total: emptyBucket(),
    cajaEntradas: null,
    diferenciaCaja: null,
  };
}

export function buildVentasPorDia(
  orders: OrderForVentas[],
  ingresos: IngresoForVentas[] | null,
  options: { cutoffHour?: number } = {}
): { dias: VentasDia[]; totales: VentasDia } {
  const cutoffHour = parseJornadaCorte(options.cutoffHour ?? 0);
  const porDia = new Map<string, VentasDia>();
  const getDia = (fecha: string) => {
    let dia = porDia.get(fecha);
    if (!dia) {
      dia = emptyDia(fecha);
      porDia.set(fecha, dia);
    }
    return dia;
  };

  for (const o of orders) {
    const dia = getDia(businessDayKey(o.createdAt, cutoffHour));
    const bucket = dia[classifyOrder(o)];
    bucket.importe += o.totalAmount;
    bucket.entradas += o.tickets;
    bucket.pedidos += 1;
  }

  // Ingreso.fecha se guarda como medianoche UTC del día elegido en el
  // formulario, así que su día es el prefijo ISO, no el de Madrid: es la
  // jornada que el usuario eligió, la misma clave con la que se agrupan las ventas.
  for (const i of ingresos ?? []) {
    if (i.concepto !== 'Entradas') continue;
    const dia = getDia(i.fecha.toISOString().slice(0, 10));
    dia.cajaEntradas = round2((dia.cajaEntradas ?? 0) + i.importe);
  }

  const dias = Array.from(porDia.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const totales = emptyDia('total');

  for (const dia of dias) {
    for (const key of VENTAS_BUCKET_KEYS) {
      dia.total.importe += dia[key].importe;
      dia.total.entradas += dia[key].entradas;
      dia.total.pedidos += dia[key].pedidos;
      totales[key].importe += dia[key].importe;
      totales[key].entradas += dia[key].entradas;
      totales[key].pedidos += dia[key].pedidos;
    }
    for (const bucket of [...VENTAS_BUCKET_KEYS.map((k) => dia[k]), dia.total]) bucket.importe = round2(bucket.importe);
    if (dia.cajaEntradas !== null) {
      dia.diferenciaCaja = round2(dia.cajaEntradas - dia.taquillaEfectivo.importe);
      totales.cajaEntradas = round2((totales.cajaEntradas ?? 0) + dia.cajaEntradas);
      // Solo se suman las diferencias de los días con caja registrada: un día
      // con efectivo vendido pero sin caja es "sin registrar", no un descuadre.
      totales.diferenciaCaja = round2((totales.diferenciaCaja ?? 0) + dia.diferenciaCaja);
    }
  }

  for (const key of VENTAS_BUCKET_KEYS) totales[key].importe = round2(totales[key].importe);
  totales.total = {
    importe: round2(VENTAS_BUCKET_KEYS.reduce((acc, k) => acc + totales[k].importe, 0)),
    entradas: VENTAS_BUCKET_KEYS.reduce((acc, k) => acc + totales[k].entradas, 0),
    pedidos: VENTAS_BUCKET_KEYS.reduce((acc, k) => acc + totales[k].pedidos, 0),
  };

  return { dias, totales };
}
