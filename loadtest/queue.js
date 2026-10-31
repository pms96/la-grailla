// Sala de espera bajo carga (P1-12): N personas entran en la cola y la sondean como lo hace el navegador (obedeciendo `pollAfterMs`).
// Mide lo que decide si la sala aguanta una venta grande: latencia de join/status y cuántas peticiones por segundo recibe la BD.
//
// Preparación (a mano, en el evento de PRUEBA que vayas a usar; no uses uno con ventas reales):
//   - Activa la sala de espera: waitingRoomEnabled = true, plazas simultáneas 20, ventana de compra 30 s (para que la cola avance).
//   - Quita el captcha de la cola en ese entorno (sin claves de Turnstile el servidor deja pasar).
//
// Uso:
//   EVENT_ID=<id del evento> WAITERS=2000 BASE_URL=http://localhost:3000 k6 run loadtest/queue.js
//
// Variables: WAITERS (por defecto 500), RAMP_S (segundos en que entran, por defecto 30), HOLD_S (cuánto sondea cada uno como máximo, por defecto 120).
//
// OJO, dos límites que NO son del script:
//   - Cada «persona» usa una IP distinta (cabecera X-Forwarded-For) para no chocar con el límite por IP (3 turnos vivos, 20 entradas/min). Eso
//     solo funciona en local (`next start`): Vercel ignora esa cabecera y todos los usuarios virtuales compartirían tu IP, así que contra un
//     preview real solo podrás generar unas pocas personas desde una máquina. Para una prueba real hacen falta varios generadores o desactivar
//     esos límites en el entorno de prueba.
//   - Mide Postgres local o el de Neon según a dónde apunte BASE_URL. Contra local NO valida capacidad real (ver README).

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const EVENT_ID = __ENV.EVENT_ID;
const WAITERS = Number(__ENV.WAITERS || 500);
const RAMP_S = Number(__ENV.RAMP_S || 30);
const HOLD_S = Number(__ENV.HOLD_S || 120);

if (!EVENT_ID) throw new Error('Falta EVENT_ID: el id del evento de prueba con la sala de espera activada');

const statusErrors = new Rate('queue_status_errors');
const joinErrors = new Rate('queue_join_errors');
const polls = new Counter('queue_polls');
const askedMs = new Trend('queue_poll_after_ms');
const admitted = new Counter('queue_admitted');
const stillWaiting = new Counter('queue_still_waiting_at_end');
const lost = new Counter('queue_lost'); // su turno desapareció (NOT_FOUND, EXPIRED, COMPLETED): personas que dejan de esperar sin ser admitidas

export const options = {
  scenarios: {
    personas: { executor: 'per-vu-iterations', vus: WAITERS, iterations: 1, maxDuration: `${RAMP_S + HOLD_S + 60}s` },
  },
  thresholds: {
    'http_req_duration{name:queue_status}': ['p(95)<1500'],
    'http_req_duration{name:queue_join}': ['p(95)<2500'],
    queue_status_errors: ['rate<0.01'],
    queue_join_errors: ['rate<0.01'],
  },
};

export default function () {
  const fakeIp = `198.51.${(__VU >> 8) % 255}.${__VU % 255}`;
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp };
  sleep(Math.random() * RAMP_S); // las personas no llegan todas en el mismo instante

  const joined = http.post(`${BASE_URL}/api/queue/join`, JSON.stringify({ eventId: EVENT_ID }), { headers, tags: { name: 'queue_join' } });
  const joinOk = check(joined, { 'join 200': (r) => r.status === 200 });
  joinErrors.add(!joinOk);
  if (!joinOk) return;
  let body = joined.json();
  const token = body.token;
  const deadline = Date.now() + HOLD_S * 1000;

  while (body.status === 'WAITING' && Date.now() < deadline) {
    // Igual que el navegador: obedece al servidor, con los mismos topes (1,5 s a 30 s) y, sin dato, 5 s.
    const asked = typeof body.pollAfterMs === 'number' ? body.pollAfterMs : 5000;
    askedMs.add(asked);
    sleep(Math.min(30000, Math.max(1500, asked)) / 1000);
    const res = http.get(`${BASE_URL}/api/queue/status?eventId=${EVENT_ID}&token=${token}`, { headers, tags: { name: 'queue_status' } });
    polls.add(1);
    const ok = check(res, { 'status 200': (r) => r.status === 200 });
    statusErrors.add(!ok);
    // Un error (429, 5xx, red) NO saca a la persona de la cola: sigue sondeando, como haría el navegador. Si abandonara, la carga ofrecida caería
    // justo cuando el servidor falla y la prueba parecería sana. `queue_status_errors` cuenta TODOS los errores, no solo el primero.
    if (!ok) continue;
    body = res.json();
  }
  if (body.status === 'ADMITTED') admitted.add(1);
  else if (body.status === 'WAITING') stillWaiting.add(1);
  else lost.add(1);
}
