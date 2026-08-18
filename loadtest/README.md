# Test de carga

Dos escenarios, cada uno prueba algo distinto:

- **`race.js`** — el momento crítico: muchos compradores a la vez contra un tipo de entrada con stock limitado. Verifica que no haya sobreventa por condición de carrera.
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
