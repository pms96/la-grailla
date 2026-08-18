// Simula el momento más peligroso: la apertura de venta de un tipo de
// entrada con stock limitado, con muchos compradores golpeando a la vez.
// Este es el escenario que expone la sobreventa por condición de carrera.
//
// Uso:
//   node loadtest/setup.js
//   BASE_URL=http://localhost:3100 k6 run loadtest/race.js
//   node loadtest/teardown.js   <- aquí se verifica si hubo sobreventa
//
// El propio k6 NO puede verificar sobreventa (no tiene acceso a la base de
// datos) — solo genera la concurrencia real por HTTP. El veredicto de
// corrección lo da teardown.js leyendo la base de datos después.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const fixtures = JSON.parse(open('./.fixtures.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const succeeded = new Counter('orders_succeeded');
const rejectedNoStock = new Counter('orders_rejected_no_stock');
const rejectedOther = new Counter('orders_rejected_other');
const unexpected = new Counter('orders_unexpected_status');

// Cada VU compra 1 entrada, todos a la vez, contra un stock de
// fixtures.scarce.maxQuantity. Con más VUs que stock, es exactamente el
// "1000 personas a la vez contra 200 entradas" del minuto de apertura.
const VUS = Number(__ENV.RACE_VUS || 300);

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '60s',
    },
  },
};

export default function () {
  // IP distinta por VU: simula compradores reales distintos y evita que el
  // rate limiter (10 pedidos/min por IP) confunda el resultado — en un pico
  // real, cada comprador tiene su propia IP.
  const fakeIp = `203.${(__VU >> 16) % 255}.${(__VU >> 8) % 255}.${__VU % 255}`;

  const res = http.post(
    `${BASE_URL}/api/orders`,
    JSON.stringify({
      eventId: fixtures.scarce.eventId,
      buyerName: 'Carga',
      buyerLastName: `VU${__VU}`,
      buyerEmail: `loadtest-race-${__VU}@example.com`,
      items: [{ ticketTypeId: fixtures.scarce.ticketTypeId, quantity: 1 }],
    }),
    { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp } }
  );

  if (res.status === 200) {
    succeeded.add(1);
  } else if (res.status === 400 && /suficientes entradas|Aforo completo/i.test(res.body)) {
    rejectedNoStock.add(1);
  } else if (res.status === 400) {
    rejectedOther.add(1);
  } else {
    unexpected.add(1);
    console.error(`Status inesperado ${res.status}: ${res.body}`);
  }

  check(res, {
    'status es 200 o 400 (nunca 5xx/429 de más)': (r) => r.status === 200 || r.status === 400,
  });
}

export function handleSummary(data) {
  const s = (name) => data.metrics[name]?.values?.count ?? 0;
  console.log(`
=== Resumen race.js ===
Compradores concurrentes:     ${VUS}
Stock disponible:              ${fixtures.scarce.maxQuantity}
Pedidos completados (200):     ${s('orders_succeeded')}
Rechazados por falta de stock: ${s('orders_rejected_no_stock')}
Rechazados por otro motivo:    ${s('orders_rejected_other')}
Respuestas inesperadas:        ${s('orders_unexpected_status')}

El veredicto real (¿hubo sobreventa?) lo da "node loadtest/teardown.js".
`);
  return {};
}
