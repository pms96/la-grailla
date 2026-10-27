/* Comprobación MANUAL de la observabilidad (P0-07), desde tu máquina. No hay ninguna ruta de prueba en el servidor: esto es lo que se ejecuta.
 *
 *   npx tsx scripts/observability-check.ts            → ensayo: monta el SDK con tu SENTRY_DSN (o uno de mentira) y un transporte que NO envía; imprime el
 *                                                       evento exactamente como saldría, con datos «personales» falsos ya filtrados. No sale nada a la red.
 *   npx tsx scripts/observability-check.ts --send     → envía UN evento de prueba de verdad al Sentry de SENTRY_DSN (etiqueta tenant=prueba-observabilidad).
 *   npx tsx scripts/observability-check.ts --alert    → envía UNA alerta de prueba (aviso, no fallo) al canal PLATFORM_ALERT_URL (y PLATFORM_ALERT_TOKEN).
 *
 * Las variables se leen del entorno o de .env. No imprime ni el DSN ni la URL de alertas. Sale con código 1 si algo falla. */
import 'dotenv/config';
import * as Sentry from '@sentry/nextjs';
import { sendPlatformAlert, platformAlertConfig } from '@/lib/observability/platform-alert';
import { initSentry, captureOps } from '@/lib/observability/sentry-server';

const args = new Set(process.argv.slice(2));
const FAKE_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
const TEST_ERROR = 'Fallo de prueba para comprador@ejemplo.es, tel 612 345 678, Bearer abc.def.ghi, https://ejemplo.es/confirmacion/x?t=TOKENSECRETO';

async function checkSentry(send: boolean): Promise<boolean> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (send && !dsn) {
    console.error('Falta SENTRY_DSN: no se puede enviar nada.');
    return false;
  }
  const printed: string[] = [];
  const dryTransport = () => ({
    send: async (envelope: unknown[]) => {
      const items = (envelope[1] as [{ type?: string }, unknown][]) ?? [];
      for (const [header, payload] of items) if (header.type === 'event') printed.push(JSON.stringify(payload, null, 2));
      return { statusCode: 200 };
    },
    flush: async () => true,
  });
  const ok = initSentry({ ...process.env, SENTRY_DSN: dsn || FAKE_DSN } as NodeJS.ProcessEnv, send ? {} : { transport: dryTransport as never });
  if (!ok) return false;
  captureOps(new Error(TEST_ERROR), { route: 'GET /prueba-observabilidad', reason: 'prueba', kind: 'entradas', order: 'abcd1234' }, 'prueba-observabilidad');
  const flushed = await Sentry.flush(5000);
  await Sentry.close(1000);
  if (send) {
    console.log(flushed ? 'Evento de prueba enviado a Sentry (búscalo por la etiqueta tenant:prueba-observabilidad).' : 'No se pudo confirmar el envío en 5 s: revisa el DSN y la red.');
    return flushed;
  }
  console.log('ENSAYO (no se ha enviado nada). Así saldría el evento:\n');
  console.log(printed[0] ?? '(el filtro descartó el evento: no debería pasar)');
  const leaks = ['comprador@ejemplo.es', '612 345 678', 'abc.def.ghi', 'TOKENSECRETO'].filter((s) => (printed[0] ?? '').includes(s));
  if (leaks.length) {
    console.error(`\nFILTRACIÓN: el evento aún contiene ${leaks.length} dato(s) falso(s) de prueba. No actives Sentry hasta arreglarlo.`);
    return false;
  }
  console.log('\nOK: ninguno de los datos personales falsos del error aparece en el evento.');
  return printed.length > 0;
}

async function checkAlert(): Promise<boolean> {
  if (!platformAlertConfig()) {
    console.error('Falta PLATFORM_ALERT_URL (https): no se puede enviar nada.');
    return false;
  }
  const res = await sendPlatformAlert({ kind: 'entradas', reason: 'prueba_observabilidad', severity: 'warning', orderId: 'abcd1234' }, { tenantId: 'prueba-observabilidad' });
  console.log(res === 'sent' ? 'Alerta de prueba enviada: debería llegarte al móvil ahora mismo.' : 'La alerta NO se pudo enviar (mira el motivo arriba).');
  return res === 'sent';
}

(async () => {
  let ok = true;
  if (args.has('--alert')) ok = (await checkAlert()) && ok;
  if (args.has('--send') || !args.has('--alert')) ok = (await checkSentry(args.has('--send'))) && ok;
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('Error inesperado:', err instanceof Error ? err.name : err);
  process.exit(1);
});
