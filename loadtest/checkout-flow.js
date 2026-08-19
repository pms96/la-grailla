// Simula tráfico mixto y sostenido a ~3.000 usuarios/minuto (50 req/s),
// con un pico por encima para ver margen. La mayoría solo navega (como en
// la vida real), una minoría compra. Objetivo: medir latencia y tasa de
// error bajo carga sostenida, no solo la corrección de stock (eso lo cubre
// race.js).
//
// Uso:
//   node loadtest/setup.js
//   BASE_URL=http://localhost:3100 k6 run loadtest/checkout-flow.js
//   node loadtest/teardown.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const fixtures = JSON.parse(open('./.fixtures.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const purchaseErrorRate = new Rate('purchase_errors');
const browseErrorRate = new Rate('browse_errors');

// Parametrizable vía env para escalar el test de estrés sin tocar el
// comportamiento por defecto (target=50/peak=100, igual que antes).
const TARGET_RATE = Number(__ENV.TARGET_RATE || 50);
const PEAK_RATE = Number(__ENV.PEAK_RATE || 100);
const MAX_VUS = Number(__ENV.MAX_VUS || 600);
const PRE_VUS = Number(__ENV.PRE_VUS || 200);

export const options = {
  scenarios: {
    trafico_sostenido: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { target: TARGET_RATE, duration: '30s' },   // rampa hasta el objetivo
        { target: TARGET_RATE, duration: '60s' },   // sostenido en el objetivo
        { target: PEAK_RATE, duration: '20s' },     // pico por encima del objetivo (margen)
        { target: 0, duration: '15s' },             // enfriamiento
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    purchase_errors: ['rate<0.05'],
    browse_errors: ['rate<0.01'],
  },
};

export default function () {
  const isBuyer = Math.random() < 0.3; // ~30% intenta comprar, el resto solo navega
  const fakeIp = `198.51.${(__VU >> 8) % 255}.${__VU % 255}`;
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp };

  const listRes = http.get(`${BASE_URL}/api/events`);
  browseErrorRate.add(listRes.status !== 200);

  const detailRes = http.get(`${BASE_URL}/api/events/${fixtures.bulk.eventSlug}`);
  browseErrorRate.add(detailRes.status !== 200);

  check(listRes, { 'listado de eventos responde 200': (r) => r.status === 200 });

  if (isBuyer) {
    const quantity = Math.random() < 0.5 ? 1 : 2;
    const res = http.post(
      `${BASE_URL}/api/orders`,
      JSON.stringify({
        eventId: fixtures.bulk.eventId,
        buyerName: 'Carga',
        buyerLastName: `VU${__VU}I${__ITER}`,
        buyerEmail: `loadtest-flow-${__VU}-${__ITER}@example.com`,
        items: [{ ticketTypeId: fixtures.bulk.ticketTypeId, quantity }],
      }),
      { headers }
    );
    purchaseErrorRate.add(res.status !== 200);
    check(res, { 'compra responde 200': (r) => r.status === 200 });
  }

  sleep(Math.random() * 0.5);
}

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration?.values?.['p(95)']?.toFixed(0);
  const failRate = ((data.metrics.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2);
  const purchaseErr = ((data.metrics.purchase_errors?.values?.rate ?? 0) * 100).toFixed(2);
  console.log(`
=== Resumen checkout-flow.js ===
Peticiones totales:         ${data.metrics.http_reqs?.values?.count ?? 0}
Latencia p95:                ${p95} ms  (umbral: <2000ms)
% peticiones fallidas (HTTP): ${failRate}%
% errores en compra:          ${purchaseErr}% (umbral: <5%)
`);
  return {};
}
