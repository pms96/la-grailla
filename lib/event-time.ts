/* Zona horaria en la que se muestran los días y horas de los eventos en la web pública. El servidor corre en UTC (Vercel) y cada visitante en la
 * suya: sin fijarla, un evento a las 00:30 del sábado en Madrid salía como «viernes» (UTC) o con el día según el país del visitante. Entradas, PDF
 * y wallet ya usan Madrid; la web pública debe decir lo mismo. */
export const EVENT_TIMEZONE = 'Europe/Madrid';
