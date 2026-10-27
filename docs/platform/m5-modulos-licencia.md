# M5 · Módulos, licencia y revocación

Qué puede usar cada cliente (módulos), hasta cuándo (licencia por fases) y cómo se le corta en una emergencia. Todo se decide en el middleware del modo plataforma, antes de que ningún handler vea la petición. El corte de La Grailla (mover el dominio) tiene su propio runbook: [`m5-cutover.md`](m5-cutover.md).

## Módulos: default-deny

`lib/modules/registry.ts` dice **quién es dueño de cada ruta** (prefijo → módulo). Pura y edge-safe.

- Una ruta **sin dueño no existe**: en modo plataforma da 404, tenga el cliente los módulos que tenga. Un test (`tests/lib/module-registry.test.ts`) enumera todas las páginas y route handlers de `app/` y **falla si alguna no tiene dueño**, así que una ruta nueva no puede colarse abierta.
- `nucleo` (landing, login, legal, `/admin`, usuarios, configuración, subida de ficheros) está siempre activo. `entradas`, `tienda`, `contabilidad`, `wallets` y `sponsors` solo si el cliente los tiene; un módulo desconocido para este front se ignora (deny).
- `wallets` exige además `entradas` o `tienda`.
- La interfaz sigue al servidor: el menú del admin, la navegación y el pie públicos y las secciones de la portada (programación, merch, patrocinio) solo muestran lo que el cliente tiene.
- Límite conocido: el panel `/admin` (dashboard) es del núcleo pero pinta datos de entradas; un cliente sin Entradas lo verá vacío. El dashboard propio de tienda es de M6.

## Licencia por fases

`licensePhase()` (`packages/contracts/src/license.ts`) es una función pura de `paidThrough` y los plazos. Con los valores por defecto:

| Fase | Desde | Qué pasa |
|---|---|---|
| `ACTIVE` | hasta `paidThrough` | normal |
| `GRACE` | `paidThrough` | aviso en el panel de admin |
| `PANEL_BLOCKED` | + 7 días (`graceDays`) | `/admin` y su API bloqueados con aviso de pago (402); la web pública y las ventas siguen |
| `BLOCKED` | + 22 días (7 + 15, acumulado) | todo cortado (503) salvo la allowlist y el login |

Los plazos son por suscripción y configurables. `paidThrough` vacío = sin caducidad (La Grailla durante el corte).

**El front avanza la fase solo.** El snapshot lleva la fase de ahora y el **calendario** de los cambios futuros; el middleware aplica los que ya han llegado, sin esperar a que el panel republique. Dos reglas protegen al cliente que paga:

1. Solo avanza con una **lectura fresca** del registro. Un snapshot servido como obsoleto (registro caído) no puede empeorar la fase: el cliente pudo pagar y no verse.
2. Un snapshot que ha pasado su `staleUntil` (168 h) tampoco avanza la fase: si el panel está caído no puede registrar pagos y no se cobra a quien no puede pagar.
3. Nunca mejora la fase por sí solo; eso solo lo hace un snapshot nuevo (al registrar un pago o canjear una clave el panel republica solo).

> **Obligatorio: refresco diario.** Por la regla 2, el panel debe volver a publicar a diario (`npm run snapshots:refresh` en `apps/control-panel`, programado). Sin él, un cliente impagado se quedaría en la fase de su último «Publicar». Desde M7 lo programa Vercel Cron del panel (`apps/control-panel/vercel.json`, a diario a las 04:17 UTC); ver `m7-operacion.md`.

### Allowlist «nunca bloqueable»

No se corta por fase **ni por módulo**: webhooks (`/api/webhooks/*`) y crons (`/api/cron/*`), la puerta de un evento (la pantalla `/acceso` solo en GET, la validación `/api/scan` y `/api/access/*`, incluida la lista de eventos `/api/access/events`, de solo lectura y solo staff; no se exime `GET /api/events`, que es la API pública de venta), el login, lo que ya compró un comprador (GET de `/confirmacion`, `/tienda/confirmacion`, `/api/orders/{id}`, `/api/shop/orders/{id}`, `/api/tickets/*`) y los reembolsos de pedidos existentes (`PATCH /api/admin/orders/{id}`). Las **ventas nuevas** sí se cortan. El `PATCH` de pedidos pasa el middleware, pero el handler solo deja `cancel` y `refund` cuando la licencia está en `PANEL_BLOCKED`/`BLOCKED` o falta el módulo (completar, verificar o cambiar el email dan 402). Las APIs de invitaciones y listas de invitados (`/api/invitations`, `/api/guest-lists`) cuentan como panel: se bloquean en `PANEL_BLOCKED`; la taquilla y el escáner son venta y puerta y siguen. Los pases de wallet no se eximen: son un módulo de pago aparte. Una suspensión (`status != ACTIVE`) es más estricta: solo deja pasar webhooks y crons, y **corta también la puerta del evento** (`/acceso`, `/api/scan`, `/api/access/*`) a propósito: la revocación de emergencia llega al front como `SUSPENDED`, es un corte de seguridad y no puede dejar rutas vivas; `PENDING_DELETION` y `DELETED` igual. La exención de la puerta es solo frente a la fase de licencia (BLOCKED) y al módulo Entradas apagado, y sigue exigiendo sesión de staff.

### Dominio no verificado

El panel solo publica dominios **verificados** (DNS o manual): uno pendiente no está en el registro y da 404 «Sitio no configurado».

## Revocación de emergencia

Botón «Revocar acceso ahora» en la ficha del cliente (SUPERADMIN u OPERATOR). Escribe `revoked:{tenantId}` en el registro: el front lo comprueba cada 5 s por cliente (una lectura por cliente cada 5 s por instancia) y lo trata como suspensión. Corta en segundos **sin republicar** y aunque el panel se caiga después; webhooks y crons siguen entrando. Publicar de nuevo no la levanta: solo «Levantar la revocación».

- Solo puede restar acceso, así que el valor no se firma (quien pudiera escribirlo ya podría borrar los registros de enrutado).
- Si el almacén no responde al comprobarla, se conserva el último valor conocido y, sin ninguno, **no** se corta: una caída del almacén no debe apagar a todos los clientes.
- Si la escritura falla, el panel no marca al cliente como revocado y deja constancia del intento.

## Claves canjeables

Una clave (`LGR-XXXXX-XXXXX-XXXXX-XXXXX`, 100 bits) activa módulos y/o alarga la vigencia. Se crea en **Licencias** (rol facturación o superadmin) y se muestra **una vez**; en la BD solo queda su hash. Se canjea en la ficha del cliente: un solo uso (reserva atómica, probado con 8 canjes simultáneos), módulos con origen `KEY`, y el panel republica solo. Inexistente, ya canjeada y caducada dan el mismo error. Una clave que alarga vigencia no se consume sobre una suscripción sin caducidad.

## Pagos

«Registrar pago» alarga `paidThrough` desde el fin de la cobertura (o desde hoy si ya venció) y republica. La facturación es manual: el panel solo registra vigencia y estado.

## Qué se comprobó

- **Tests:** 54 nuevos en la raíz (límites exactos día 7 y 22, plazos configurables, calendario y «nunca mejora» en el contrato; default-deny sobre todas las rutas; módulos, fases, avance por calendario, lectura obsoleta que no empeora ni parpadea, revocación, allowlist y el `PATCH` de pedidos en el middleware) y 27 en el panel (plazos, pagos, claves, revocación, refresco; con mutaciones comprobadas: sin la reserva atómica o sin el bloqueo por suscripción, los tests de concurrencia fallan).
- **Navegador, front real + panel real** (`a.localhost`, `b.localhost`): menú y portada sin los módulos que el cliente no tiene; un módulo apagado da 404; `GRACE` pinta el aviso con la fecha de bloqueo; `PANEL_BLOCKED` devuelve **402** en `/admin` con la pantalla de aviso (y 402 JSON en su API) con la web pública intacta; `BLOCKED` devuelve 503 en todo menos login, webhook (llega al handler) y aviso; registrar el pago lo restablece en ≤ 15 s; «Revocar acceso ahora» corta a un cliente (503) sin tocar al otro y «Levantar» lo restablece; canjear una clave en el panel abre las rutas de Contabilidad.
- `npm run platform:preflight` (ver el runbook) contra el registro y la BD locales: detecta variables globales, claves mal formadas, un dominio fuera del registro y una credencial cifrada ilegible.

## Revisión de seguridad (agente independiente, 8 oct 2026)

Sin hallazgos altos ni bypass del gating sin sesión de staff. Verificados y arreglados, con test que falla sin el arreglo:

| # | Hallazgo | Arreglo |
|---|---|---|
| 1 (medio) | En un acierto de la caché L1 el snapshot se devolvía siempre como «fresco», aunque hubiera pasado su `staleUntil`: con el refresco diario parado, la fase *parpadeaba* entre ACTIVE y BLOCKED según el instante del ciclo de 15 s. | `stale` se calcula también en los aciertos de L1 (`now > staleUntil`). |
| 2 (medio) | `PATCH /api/admin/orders/[id]` exento de fase y módulo, pero el handler también completa pedidos, emite entradas y cambia emails. | El handler solo admite `cancel`/`refund` con licencia vencida o sin módulo (402 en el resto). |
| 3 (medio) | Con el almacén caído, la comprobación de revocación sumaba hasta 3 s a cada petición (su caché se medía desde el inicio, no el final del intento). | Timeout propio de 1,5 s, `checkedAt` al terminar y backoff de 15 s tras un fallo. |
| 4 (medio) | Facturación no podía publicar: registrar un pago guardaba pero «no se podía publicar», y el cliente seguía bloqueado hasta el refresco. | `BILLING` tiene `publish`. |
| 5 (bajo) | `/api/invitations` y `/api/guest-lists` seguían vivos en `PANEL_BLOCKED`. | Cuentan como panel. |
| 8 (bajo) | Pagos/canjes simultáneos podían perder uno; `expiresInDays` sin validar; `2026-02-31` pasaba a 3 de marzo; guardar sin tocar la fecha la movía horas; una fecha pasada publicaba el bloqueo al instante sin avisar. | Bloqueo por suscripción en los tres cambios, validación, fecha comprobada, el formulario edita el día de Madrid y pide confirmación. |
| 9 (bajo) | Con el calendario agotado el aviso podía mostrar una fecha pasada; el 402/503 JSON anónimo revelaba la fase. | `nextPhaseChangeAt` null y cuerpo sin la fase. |
| 10 (bajo) | El refresco fallaba siempre en las suscripciones sin dominio verificado. | Se omiten. |

**Decisiones que se mantienen:** las exenciones saltan también el módulo (operan sobre la BD del propio cliente: no hay fuga entre clientes, solo datos que ya son suyos); una clave no está ligada a un cliente concreto y cualquier operador con `billing:write` puede canjearla donde quiera (crear + canjear equivale a activar módulos, queda auditado; es el trabajo de facturación).

## Lo que NO está hecho (y por qué)

- **`seq` persistente en el front.** El anti-replay sigue en la memoria de cada instancia (ya por cliente y producto). Persistirlo en el mismo almacén no protege de quien lo controle (borraría el contador), y un almacén aparte añade un proveedor y un modo de fallo. El riesgo real (un snapshot antiguo con firma válida repuesto en el almacén) exige acceso de escritura al registro, que ya permitiría borrar los dominios. Se deja con la dependencia del refresco diario (un snapshot viejo se vuelve «obsoleto» a las 168 h) y se reconsiderará en el umbral de ~15 clientes con el resto del endurecimiento.
- **Pestañas de configuración por módulo** (parte del registro en el plan): el menú, la portada y las rutas sí; las pestañas de `/admin/configuracion` por módulo van con la apariencia en M6.
- **El corte en sí** (mover el dominio en Vercel) y las dos semanas de observación: requieren el entorno real. Está preparado: ver el runbook.
- Dashboard propio de tienda, apariencia, bandeja de contacto: M6.
