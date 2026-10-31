# Test de carga

Tres escenarios, cada uno prueba algo distinto:

- **`race.js`** — el momento crítico: muchos compradores a la vez contra un tipo de entrada con stock limitado. Verifica que no haya sobreventa por condición de carrera.
- **`queue.js`** — la sala de espera (P1-12): N personas entran en la cola y la sondean como el navegador, obedeciendo `pollAfterMs`. Mide latencia de join/status y, con ella, cuántas consultas por segundo recibe la BD. Necesita un evento de prueba con la sala activada; la cabecera del script explica cómo prepararlo y sus dos límites (IP por usuario virtual solo en local; local no valida la capacidad de Neon).
- **`checkout-flow.js`** — tráfico mixto sostenido a ~3.000 usuarios/minuto (50 req/s), con un pico por encima. Mide latencia y tasa de error bajo carga, no la corrección del stock.

## Cómo ejecutarlo

Requiere [k6](https://k6.io) instalado (`brew install k6`).

```bash
node loadtest/setup.js                                    # crea eventos/tickets de prueba, gateway "mock"
BASE_URL=http://localhost:3000 k6 run loadtest/race.js
BASE_URL=http://localhost:3000 k6 run loadtest/checkout-flow.js
node loadtest/teardown.js                                  # verifica que no hubo sobreventa y limpia todo
```

`BASE_URL` apunta a donde quieras probar: local (`next start`, no `next dev` — el modo dev compila sobre la marcha y da números falsos), o un *preview* real de Vercel apuntando a Neon, que es el entorno que de verdad importa antes de vender entradas reales.

**Siempre ejecuta `teardown.js` al final** — es el único paso que de verdad dice si hubo sobreventa (k6 solo genera la carga por HTTP, no tiene acceso a la base de datos) y el que limpia los eventos/pedidos de prueba y restaura la configuración de pagos.

Si `setup.js` falla porque ya existe `loadtest/.fixtures.json`, es que quedó un test anterior sin `teardown.js` — ejecútalo antes de repetir.

## Ajustar los parámetros

- `RACE_VUS` (env var de `race.js`, por defecto 300): número de compradores concurrentes en la carrera.
- `SCARCE_STOCK` (constante en `setup.js`, por defecto 200): stock del tipo de entrada limitado.
- Las etapas de `checkout-flow.js` (rampa/sostenido/pico) están en su bloque `options.scenarios` — ajusta los `target` si tu cifra real de tráfico esperado es distinta a 3.000/min.

## Resultado de referencia (local, `next start` + Postgres en Docker)

- `race.js`: 300 compradores contra 200 entradas → exactamente 200 completados, 100 rechazados por falta de stock, 0 sobreventa.
- `checkout-flow.js`: ~14.000 peticiones en ~2 minutos, p95 de latencia ~13ms, 0% de errores.

Esto solo confirma que la lógica de la app es correcta y no añade cuellos de botella propios — **no sustituye probar contra el despliegue real en Vercel + Neon**, donde la latencia de red y el pool de conexiones son completamente distintos a correrlo todo en local.

## Sala de espera: qué se hizo y qué no (P1-12)

**Hecho (en Postgres, sin infraestructura nueva).** Cada sondeo de estado hacía unas 11 sentencias (rate limit, evento completo, transacción de barrido con cerrojo, entrada, posición). Ahora: el evento se lee solo con 5 campos; el barrido se limita a uno por segundo y evento en cada instancia (`join` no se limita, para admitir al momento); y el servidor dice cuándo volver a sondear (`pollAfterMs`: 2 s hasta la posición 10, 5 s hasta 50, 8 s hasta 200, 12 s hasta 1.000, 20 s más allá, con ±20 % de dispersión). Estimación, no medida: con 5.000 esperando, de unos 625 sondeos/s y unas 11 sentencias cada uno (~6.900/s) a unos 300 sondeos/s y unas 4 sentencias (~1.200/s), cinco veces menos.

**No hecho: moverla a Redis.** Es la solución definitiva, pero cambia infraestructura (un Redis con claves por cliente) en el flujo de venta, y la capacidad real de Neon es una hipótesis. Primero hay que medir: ejecuta `queue.js` contra un preview con Neon y mira latencia y conexiones. **Umbral para hacerlo:** si con la carga esperada de una venta (esperando simultáneos) el p95 de `/api/queue/status` supera 1,5 s, o el pool de Neon se satura, o se prevén más de ~5.000 esperando en una celda compartida.
