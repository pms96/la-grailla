# Observabilidad: captura de errores, alertas del operador y señales de negocio

Cierra la parte de código de **P0-07** de la [auditoría de lanzamiento](auditoria-lanzamiento.md) («ceguera operativa: ningún fallo transaccional avisa»; OB-02, OB-05, OB-06 del [anexo 5](auditoria-lanzamiento/anexo-5-fiabilidad-observabilidad.md)). Son tres piezas independientes, todas **inertes mientras no se configuren**:

| Pieza | Qué hace | Se activa con | Dónde |
|---|---|---|---|
| 1. Captura de errores del servidor | Un 5xx inesperado o una pasada de reconcile fallida llega a Sentry con la etiqueta `tenant` y sin datos personales | `SENTRY_DSN` | front (`instrumentation.ts`, `lib/observability/`) |
| 2. Canal de alertas del operador | Los avisos de dinero salen también a tu móvil (ntfy), sin depender del SMTP ni del `admin_email` del cliente | `PLATFORM_ALERT_URL` (+ `PLATFORM_ALERT_TOKEN`) | front (`alertOperator`) |
| 3. Señales de negocio en el panel | El panel lee el bloque `ops` de `/api/health` y avisa de pedidos pendientes, emails sin enviar y reconcile caído | nada: se aplica solo si el front manda `ops` | `packages/contracts`, `apps/control-panel` |

Nada de esto se ha probado contra un Sentry ni un ntfy reales (ver «Lo que no está verificado»).

## 1 · Captura de errores (Sentry, solo servidor)

### Qué captura y qué NO

| Captura | No captura |
|---|---|
| Errores 5xx inesperados de las rutas que pasan por `handleApiError` (checkout, pedidos de tienda, webhooks, crons…) con ruta, proveedor y tipo (`entradas`/`tienda`) cuando el punto de la llamada los conoce | Los 4xx (validación `ZodError` → 400, `P2003` → 409): los provoca quien llama, no son una incidencia |
| `POST /api/orders` y `POST /api/shop/orders` cuando la pasarela no puede abrir la sesión de cobro (el 502 del checkout: clave caducada o pasarela caída; `reason=checkout_session_failed`, con proveedor, tipo y pedido truncado) | |
| `POST /api/webhooks/*` que acaba en 500 (lleva `provider` y `kind`) | Nada del **navegador**: no hay SDK de cliente (no engorda el JS de las páginas públicas ni arriesga datos de compradores) |
| Una pasada de `reconcile-payments` que no reconcilia nada (la que responde 502): `reason=failed_pass` | Trazas de rendimiento (`tracesSampleRate: 0`), sesiones, replays, logs, perfiles |
| Errores que Next ve sin que nuestro código los capture (render de páginas, handlers sin `try/catch`) vía `onRequestError` | Errores del middleware (edge): no hay SDK en edge |

### Política de datos (PII)

Tres barreras, de la más a la menos fiable:

1. **No se le pasa nada personal.** El contexto explícito (`captureOpsError`) solo admite ruta (patrón, no la URL real), proveedor, tipo, motivo y el **id de pedido truncado a 8 caracteres**. La firma no admite nombre, email, teléfono, importes ni URLs.
2. **El SDK no recoge nada por su cuenta.** La versión 11 retiró `sendDefaultPii` y sus valores por defecto recogen todo (usuario, cookies, cabeceras, cuerpos, query, variables locales): `dataCollection` apaga cada categoría. Solo hay tres integraciones (filtro de eventos, cadena de causas, deduplicado): ni consola, ni HTTP/fetch (esas generan breadcrumbs con URLs y argumentos), ni manejadores globales de excepciones, ni lectura de ficheros para pintar código. Sin OpenTelemetry (`enableOpenTelemetrySetup: false`) ni inyección de módulos.
3. **`scrubEvent` / `scrubBreadcrumb` (`lib/observability/scrub.ts`)**, función pura que se aplica a CADA evento y breadcrumb antes de salir (y, si falla, el evento se descarta): elimina `request` (cabeceras, cookies, cuerpo, query string, URL), `user`, `server_name`, `modules` y `sdkProcessingMetadata` (que lleva la petición normalizada); de la pila solo salen rutas relativas, nombres de función y líneas (sin código ni variables); de los contextos solo lo seguro (`runtime`, `trace`, `nextjs.router_path`, nunca la ruta concreta); solo una lista cerrada de etiquetas; y redacta en todo texto libre emails, teléfonos, `Bearer`/`Basic`, JWT, claves `sk_`/`rk_`/`pk_`/`whsec_`, ids de pago/sesión de Stripe, URLs de BD o Redis, credenciales y query strings de URLs, parámetros `t=`/`token=`/`signature=`…, UUID y cuid (truncados a 8) y cadenas opacas largas. Un error de Prisma (que lleva la consulta con sus valores) se reduce a la operación y la última línea del error, con cualquier nombre de llamada (`prisma.x.y()`, `tx.x.y()`, `p.x.y()`, `prisma.$queryRaw()`…), sin lo que haya entre comillas ni lo que siga a «provided»; de un SQL en crudo solo queda el código SQLSTATE; y un `PrismaClient*Error` sin «invocation» en el mensaje conserva solo su primera línea. En `extra` se descartan por completo las claves con nombre de persona o de credencial (`buyerName`, `firstName`, `email`, `phone`, `address`, `token`…); `threads`, `debug_meta` y `spans` se eliminan.

**Qué redacta `scrubString`** (probado con los mensajes reales de Prisma 6.7 y casos adversarios en `tests/lib/observability-scrub*.test.ts`): emails (también `%40` y de ancho completo), teléfonos (con `+`, con paréntesis, 9 a 11 cifras sueltas), IBAN, DNI/NIE, números de tarjeta (13 a 19 cifras), IPv4 e IPv6, hosts de BD gestionada (Neon, Supabase, RDS, PlanetScale, Upstash…), cualquier `host:puerto`, dominios con TLD habitual (`.es`, `.com`, `.net`, `.org`, `.eu`, `.io`, `.app`, `.dev`…: el Host de un cliente en un mensaje), query strings de URLs absolutas y relativas, cabeceras `Cookie:`, `Bearer`/`Basic`, JWT, claves y secretos de pasarela, ids de pago, URLs de BD/Redis, credenciales en URLs, UUID/cuid (a 8 caracteres) y cadenas opacas largas. Cada expresión está acotada (sin backtracking): el peor caso medido con 4000 caracteres adversarios es de 2 ms.

**Qué NO cubre `scrubString`** (riesgo residual asumido): nombres propios y direcciones postales en texto libre (por eso Prisma se colapsa por estructura y no por patrones), dominios con un TLD que no esté en la lista (`.tv`, `.co`, `.me`, `.de`…: se excluyeron a propósito los que coinciden con nombres de propiedad o extensiones de fichero), identificadores internos de terceros sin forma conocida, y datos personales dentro de un campo que no sea texto. Sobre-redacta a propósito cifras sueltas de 9 a 11 dígitos y números largos (marcas de tiempo): se prefiere perder un dato de diagnóstico.

**Etiqueta `tenant`:** el id del cliente (ULID) tomado del contexto de la petición (`currentTenant()`), o de la cabecera firmada (`x-grailla-ctx`, verificada con HMAC) cuando Next llama a `onRequestError` fuera de ese contexto. Si no hay contexto (tareas, instalación única) no se pone. **Nunca el Host ni el nombre del negocio**: si algo intentara poner un valor que parece un dominio o un nombre, se descarta. Además sale `deployment=platform|single` para distinguir el proyecto `platform` del antiguo.

Límite razonable de lo que NO se puede garantizar: el texto libre de un mensaje de error de una librería de terceros podría contener un dato personal con una forma que las expresiones regulares no reconozcan (un nombre propio, una dirección). Por eso la primera barrera es no pasar datos y por eso `captureOpsError` nunca recibe el objeto del pedido.

### Configuración exacta

`instrumentation.ts` (raíz): `register()` solo con `NEXT_RUNTIME === 'nodejs'` **y** `SENTRY_DSN`; `onRequestError` igual. Los imports son dinámicos y están dentro de esa condición: sin DSN el SDK no se evalúa ni se carga (comprobado: ningún fichero de `@sentry` abierto por el proceso) y el bundle del middleware no lo incluye.

| Opción | Valor |
|---|---|
| `dsn` | `SENTRY_DSN` |
| `environment` | `VERCEL_ENV` (`production`/`preview`/`development`), si no `NODE_ENV` |
| `release` | `VERCEL_GIT_COMMIT_SHA` |
| `tracesSampleRate` | `0` (solo errores) |
| `maxBreadcrumbs` | `5` (y no hay origen automático de breadcrumbs) |
| `dataCollection` | todo apagado (usuario, cookies, cabeceras, cuerpos, query, variables, DB, colas) |
| `sendClientReports`, `enableOpenTelemetrySetup`, `enableRuntimeChannelInjection` | `false` |
| Tope por instancia | 20 capturas por minuto (si la BD cae, cada petición da un 500: sin tope, un evento por petición) |
| Envío | en segundo plano (`flush` de 2 s colgado de `waitUntil` de Vercel): ni la respuesta al comprador ni el webhook esperan a Sentry; el SDK nunca lanza |

`next.config.js` añade `serverExternalPackages: ['@sentry/nextjs']`: sin ello webpack empaquetaría el SDK dos veces (una para `instrumentation.ts` y otra para el import dinámico de `capture.ts`: +3,7 MB de servidor y dos instancias). Como paquete externo se carga de `node_modules`, una sola vez, y solo cuando alguien lo importa. **No se usa `withSentryConfig`**: no toca el build, no sube source maps y no necesita token.

### Versión del SDK y qué arrastra

`@sentry/nextjs` **11.7.0**, versión exacta (publicada el 2026-10-12; la más reciente de la línea 11 con más de dos semanas de antigüedad el 2026-10-27; la 11.8 y la 11.9 son de hace menos de 14 días). Es la vía soportada para Next 15 (`peerDependencies.next: ^14 || ^15 || ^16`); no declara peer de React. Exige Node `>=22.12` (el proyecto usa Node 22, `.nvmrc`). Sin avisos de deprecación en npm y `npm audit --omit=dev` **no cambia** (mismas 10 vulnerabilidades preexistentes, ninguna atribuible a Sentry).

Elegida frente a la 10.76.2 (línea anterior): arrastra 73 paquetes en lugar de 181 y ningún script de instalación (la 10 depende de `@sentry/cli`, que tiene `install`). Se instala con 44 paquetes nuevos (87 entradas en el lockfile, la mitad binarios opcionales de otras plataformas); **ningún paquete existente cambia de versión**. Peso: ~78 MB de `@sentry/*` en `node_modules` (más `sentry` CLI de 15 MB y `rollup`/`oxc-parser` que solo usa `withSentryConfig`, que NO se usa y por tanto no entra en la función), y ~3,4 MB de ficheros de Sentry trazados al empaquetar la función. Sin SDK de navegador: los *First Load JS* de todas las páginas son idénticos.

### Compromiso: trazas minificadas

Como no se suben source maps (necesitaría token y `withSentryConfig`), las pilas del servidor salen minificadas (`api/orders/route.js` línea 1, columna 5892). El tipo de error, el mensaje redactado, la ruta, el `tenant` y el `release` (SHA) suelen bastar para localizar el fallo. Medido en el build de prueba:

| | Servidor (JS) | First Load JS públicas | Arranque en frío |
|---|---|---|---|
| Antes (sin Sentry) | 17,18 MB | referencia | sin diferencia apreciable |
| Con Sentry externo (lo entregado) | 17,69 MB (+0,5 MB) | **idéntico** (el *Middleware* pasa de 84,2 a 84,5 kB por el hook de instrumentación) | sin diferencia apreciable; sin DSN el SDK no se carga |
| `experimental.serverMinification: false` (para legibilidad) | 38,29 MB (**+20,6 MB**) | idéntico | sin diferencia apreciable |

`serverMinification: false` hace legibles las pilas pero **más que duplica** el servidor, así que no se activa. Siguiente paso si hace falta: subir los source maps del servidor a Sentry en el build (necesita `SENTRY_AUTH_TOKEN` y `withSentryConfig`); se decide cuando haya un fallo real que no se pueda localizar sin ellos.

## 2 · Canal de alertas del operador

`alertOperator` (`lib/reconciliation/shared.ts`) es el único punto por el que el sistema avisa al operador de algo que toca dinero. Ahora sale por **dos canales en paralelo e independientes**: el correo al `admin_email` del cliente por el SMTP del cliente (como siempre) y un `POST` directo a `PLATFORM_ALERT_URL`. Si el SMTP falla, si no hay `admin_email` o si la consulta del correo lanza, el canal del operador se intenta igual; si el canal del operador falla o no está configurado, el correo sale como siempre. Sin `PLATFORM_ALERT_URL` el comportamiento es el de antes.

Hasta ahora `paymentMatchesOrder` (importe cobrado que no cuadra) tenía su propio envío de correo al margen de `alertOperator`: ahora pasa por él, así que también sale por los dos canales (una vez al día por pedido, clave `amount-mismatch:<pedido>`).

| Variable | Qué es |
|---|---|
| `PLATFORM_ALERT_URL` | URL **https** de un tema de ntfy o de un webhook de Slack, Discord o JSON. **Es un secreto.** Sin ella no se envía nada |
| `PLATFORM_ALERT_TOKEN` | Opcional. Se envía como `Authorization: Bearer` (ntfy con control de acceso, webhooks propios) |

Puedes usar el **mismo tema de ntfy** que ya usa el panel (`ALERT_WEBHOOK_URL`): los avisos llegan al mismo sitio. Mismo formato que el panel: ntfy recibe texto plano con `Title`/`Priority`/`Tags`; Slack, `text`; Discord, `content`; cualquier otro, un JSON con `severity`, `title`, `tenant`, `kind`, `reason`, `order` y `at`. Mismas reglas: un solo intento, tiempo máximo de 4 s, no sigue redirecciones, no lanza, y los errores se anotan sin el mensaje (podría llevar la URL).

Ejemplo de lo que llega:

```
🔴 FALLO entradas: refund_failed
Cliente: 01JXXXXXXXXXXXXXXXXXXXXXXX
Tipo: entradas
Motivo: refund_failed
Pedido: cm9abcde
```

Lleva la severidad, el id del cliente (en el proyecto antiguo, `instalacion-unica`), el tipo, el motivo y el pedido **truncado a 8 caracteres**. Nunca datos del comprador, importes ni URLs firmadas (la función no admite esos campos; `kind` y `reason` solo aceptan caracteres de un identificador). Severidad: `refunded_no_capacity`, `refunded_in_gateway` y `stuck_processing` informan y salen como **aviso**; el resto (`refund_failed`, `paid_but_inactive`, `amount_mismatch`, `stuck_unknown`, `payment_refunded_on_pending_order`…) como **fallo**. El `dedupeKey` existente limita a un aviso por clave y día en los dos canales; si la consulta del límite falla, se avisa igualmente (mejor repetido que perdido).

## 3 · Bloque `ops` y reglas del panel

El front (otro paquete de trabajo) añade a `GET /api/health` con el secreto de cron del cliente un bloque **aditivo** `ops`; el contrato está en `packages/contracts/src/health-ops.ts` (`OpsBlockSchema`, `parseOpsBlock`):

```
ops: { generatedAt, pendingOldestMinutes | null, pendingOver20min, emailsUnsent, emailsFailed,
       reconcile: { lastRunAt | null, errors, unknown, processing, stuckOver24h } | null,
       gateway?: { lastRunAt, checked, unmatched, errors, skipped, truncated } | null,
       sales?: { orders15min, waitingRoom } | null }
```

`sales` (P1-22) es la actividad de venta ahora: pedidos de entradas creados en los últimos 15 min y personas en la sala de espera (esperando o admitidas). Solo contadores. No genera avisos: lo lee el runner de migraciones (`isSalesWindowBusy` en el contrato: sala de espera con gente, o 5 o más pedidos en 15 min) para negarse a migrar a un cliente en plena venta (`m7-operacion.md` §2 y §7).

Es opcional: un front anterior sin `ops` sigue siendo válido (el panel no aplica ninguna regla) y los campos que el contrato no conoce se ignoran. Un `ops` que **no** cumple el contrato no deja al cliente como «no responde»: se señala como un problema aparte («el bloque ops no cumple el contrato»), sin copiar lo recibido.

### Umbrales (de la auditoría §4)

| Señal | Condición | Gravedad | Aviso |
|---|---|---|---|
| Pedidos pendientes de pago | `pendingOver20min > 0` | aviso | «pedidos pendientes de pago» |
| Idem, sin resolver | `pendingOldestMinutes > 30` | **fallo** | «pedidos pendientes de pago sin resolver (más de 30 min)» |
| Emails sin enviar | `emailsUnsent > 0` **sostenido ≥ 10 min** (dos comprobaciones seguidas, no un tropiezo suelto) | aviso | «emails sin enviar» |
| Emails con error | `emailsFailed > 0` | **fallo** | «emails con error de envío» |
| Reconcile con errores | `reconcile.errors > 0` o `unknown > 0` o `stuckOver24h > 0` | **fallo** | «el reconcile tiene errores» |
| El reconcile no corre | `reconcile.lastRunAt` de hace más de 15 min | **fallo** | «el reconcile no corre» |

| **Cobro sin pedido** | `gateway.unmatched > 0` (umbral 0) | **fallo** | «cobros sin pedido confirmado» |
| Conciliación con la pasarela sin hacer | `gateway.errors > 0` o `gateway.lastRunAt` de hace más de 36 h | aviso | «conciliación con la pasarela sin hacer» |

`reconcile.processing` (cobros en curso) no es una señal. Con `reconcile: null` o `lastRunAt: null` (nunca se ha registrado una pasada) no se avisa de que no corre: de eso ya avisa la tarea `reconcile-payments` del propio panel (3 fallos seguidos). La sostenibilidad de los emails cuenta además la antigüedad que ya descuente el front al calcular `emailsUnsent` (la auditoría usa 10 min + 15 min sostenidos).

### Conciliación diaria pasarela → BD (alerta nº 1: «cobro sin pedido»)

Todo lo demás parte de un pedido que existe. Un cobro cuyo pedido no existe, o existe sin confirmar, solo se ve recorriendo la **pasarela**. La tarea `reconcile-gateway` del panel (una vez al día por cliente, solo lectura; ruta `GET /api/cron/reconcile-gateway`, código en `lib/reconciliation/gateway.ts`) lo hace:

- **Stripe** (cobertura completa): lista las sesiones de Checkout **pagadas** de las últimas 48 h, menos las de los últimos 45 min (aún siguen el flujo normal), y exige que cada una tenga un pedido pagado, por `paymentId` o por el `metadata.orderId` con el que se creó. `no_order` = cobrada y sin pedido; `order_not_confirmed` = su pedido sigue pendiente o cancelado. Un cargo reembolsado (total o parcial) se da por resuelto, y una sesión sin `metadata.orderId` no es de esta plataforma y se ignora (la cuenta de Stripe puede usarse para otras cosas). Una misma cuenta compartida por Entradas y Tienda se recorre una vez. **Requisito: una cuenta de Stripe por cliente** (decisión del producto): la metadata de la sesión no lleva el cliente, así que dos clientes con la MISMA cuenta verían las sesiones del otro como «sin pedido». Entradas y Tienda con claves distintas de una misma cuenta contarían el cobro dos veces. Solo sesiones completas (las abiertas y caducadas no pueden estar pagadas). Tope de 10 páginas de 100 y 30 s, con tiempo propio por llamada (10 s, sin reintentos): si se corta, `truncated`, y el panel lo avisa como «conciliación sin hacer».
- **SumUp** (cobertura PARCIAL, `skipped = 1`): su API **no permite** listar cobros por fecha con nuestra referencia (el historial de transacciones no la lleva), así que **no se puede detectar un cobro sin pedido**. Lo que sí se hace es el sentido contrario para los pedidos sin pagar de las últimas 48 h (los 150 más recientes): se pregunta a SumUp por su checkout (por `paymentId`, o por la referencia si el pedido nunca guardó el suyo: `paid_reference_without_id`).

El resultado queda en `ops_gateway_last` (bloque `ops.gateway` del health) y, si hay algo, sale **un aviso por los dos canales del operador** (correo del cliente y `PLATFORM_ALERT_URL`) con importe, id del cobro y del pedido, **sin datos del comprador**. El aviso del front sale **como mucho una vez al día** por conjunto de cobros (el límite de `alertOperator` es de 24 h desde el último aviso; un recordatorio diario exacto no está garantizado) y un cobro nuevo cambia el conjunto y avisa en el momento; el panel mantiene la señal en rojo en Salud mientras `unmatched > 0`. Una pasada que no pudo consultar alguna cuenta no da por resuelto un incidente anterior. Si la tarea no pudo mirar **ninguna** cuenta (clave inválida, pasarela caída) responde 502 y el disparador del panel la cuenta como fallo y reintenta con backoff; que haya cobros sin pedido NO es un fallo de la tarea, es el hallazgo. **Qué hacer ante el aviso:** abrir el cobro en el panel de la pasarela y confirmar o reembolsar a mano.

### Cómo avisa (sin inventar otro mecanismo)

Se reutiliza el de la salud técnica: la tarea `health` (cada 5 min) compara con la comprobación anterior y avisa **solo en el cambio**: aparece una señal, escala de aviso a fallo, o todo vuelve a la normalidad («las señales de operación vuelven a la normalidad», una sola vez). Un único aviso por cliente y pasada con todo lo nuevo; mismo tope de 10 avisos por pasada y mismos canales (`ALERT_WEBHOOK_URL`, `ALERT_EMAIL_TO`). Una señal activa en la primera lectura sí avisa. Si el cliente deja de responder, o manda `ops` ausente, nulo o inválido, las líneas de operación anteriores se **conservan** en el nuevo `error`: al volver no se repite el aviso de lo ya avisado y, si se resolvió durante la caída, se avisa la recuperación. Un aviso que NO salió (omitido por el tope de 10 por pasada, o con todos los canales caídos) deja su línea marcada con «[aviso pendiente]» y se vuelve a intentar en la siguiente pasada (sin canales configurados no se reintenta: solo queda en el log). Un «recuperado» omitido por el tope no se reintenta. Un estado «degradado» que venía solo de las señales de operación no cuenta como estado técnico anterior: si luego aparece un problema técnico, también avisa («la web responde pero no está sana»).

**Sin migración de BD.** Las señales activas se guardan como líneas `Operación: …` al principio de `TenantHealth.error` (hasta 1200 caracteres) y esas mismas líneas son la memoria del estado anterior (cada señal se reconoce por una frase fija; hay test). La ficha del cliente (`/tenants/[id]`, «Operación → Salud») las pinta como lista aparte, y la página **Salud** como problemas separados (los fallos en rojo, los avisos en ámbar). Limitaciones asumidas: una comprobación manual («Comprobar salud») entre dos pasadas del disparador puede consumir una transición sin avisar (ya pasaba con la salud técnica); no se conservan los números históricos de `ops`, solo lo que dicen las líneas; y si se vuelve a un front sin `ops`, las líneas conservadas no se limpian solas hasta que un front con `ops` vuelva a medir. Si se quiere histórico o gráficas, la opción limpia es una columna JSON `ops` en `TenantHealth` (migración aditiva del panel): no se ha añadido sin consultar.

## 4 · Puesta en marcha (lo que tienes que hacer tú)

### 4.1 Sentry en la región UE

1. Crea una cuenta en sentry.io. **Al crear la organización elige «Data Storage Location: European Union (EU)»** (no se puede cambiar después; si ya existe una en EE. UU., crea otra).
2. Crea un proyecto, plataforma **Next.js** (o Node), llamado `grailla-front`. Si quieres separar, un proyecto por Vercel project; con la etiqueta `deployment` y `tenant` basta con uno.
3. Copia el **DSN** (Settings → Client Keys). Debe ser de la forma `https://<clave>@o<n>.ingest.de.sentry.io/<proyecto>`: el `.de.` indica la región UE. Si el host es `ingest.sentry.io` o `ingest.us.sentry.io`, es la región de EE. UU.: no lo uses.
4. En Settings → Security & Privacy deja activado «Prevent Storing of IP Addresses» y «Data Scrubber»/«Use Default Scrubbers» (refuerzo, no sustituye al filtro del código).

### 4.2 Subencargado y DPA

**Sentry pasa a ser un subencargado de tratamiento nuevo** (recibe el tipo y el mensaje de errores del servidor, el id de cliente, el id de pedido truncado y la ruta; en principio ningún dato personal, pero un mensaje de error de una librería podría llevar alguno ocasional). Antes de activarlo con clientes reales: (1) aceptar el DPA de Sentry (en su web, sección legal, o desde la cuenta de la organización; confírmalo ahí); (2) **añadirlo a la lista de subencargados del DPA con los clientes** (hoy: Vercel, Neon, Upstash, Vercel Blob y el servicio de correo del panel, ver [ficha de alta](ficha-alta-cliente.md)); (3) que lo revise el abogado junto con el resto. Si se prefiere no incorporarlo todavía, basta con no definir `SENTRY_DSN`: el resto de piezas funcionan sin él.

### 4.3 Variables en Vercel

En los dos proyectos del front: el nuevo **`platform`** (en [m9](m9-primer-despliegue.md) se llama `grailla-platform`) y el antiguo **`la-grailla`**. Settings → Environment Variables, marcadas **Sensitive** y **solo en el entorno Production** (en Preview no: los despliegues de prueba mandarían errores de pruebas):

| Variable | Valor |
|---|---|
| `SENTRY_DSN` | el DSN de la UE del paso anterior |
| `PLATFORM_ALERT_URL` | `https://ntfy.sh/<tu-tema-secreto>` (el mismo del panel o uno nuevo; genera el nombre con `openssl rand -hex 12`) |
| `PLATFORM_ALERT_TOKEN` | solo si el tema o el webhook exige token |

**Comprueba antes la versión de Node de cada proyecto del front** (Vercel → Settings → Build and Deployment → Node.js Version): `@sentry/nextjs` 11.7.0 exige Node `>=20.19`, `>=22.12` o `>=23.2`. El repo fija `22` en `.nvmrc` (lo usa la CI) pero el `package.json` del front **no tiene `engines`**, así que en Vercel manda el ajuste del proyecto: `22.x` o `20.x` valen (Vercel instala la última versión de la serie); `18.x` NO. El proyecto antiguo `la-grailla` puede estar en una serie anterior: míralo antes de poner `SENTRY_DSN`. Si la versión no sirve, el servidor arranca igualmente sin Sentry y deja una línea `[sentry] la carga del SDK falló` en el log (una sola vez), pero no habrá captura.

Después **redespliega** ambos proyectos (las variables no se aplican a despliegues ya hechos). El panel (`panel-control`) hay que **redesplegarlo** también (recoge las reglas de `ops`), pero no necesita variables nuevas: usa las suyas (`ALERT_WEBHOOK_URL`, `ALERT_EMAIL_TO`, `HEARTBEAT_URL`). En el proyecto antiguo, su build migra la BD real (`prisma migrate deploy`) salvo con `SKIP_MIGRATE_ON_BUILD=1`, y una Preview ya lo hizo una vez (P1-22 de la auditoría): confirma que esa variable está puesta antes de redesplegar.

### 4.4 Reglas mínimas dentro de Sentry

Alerts → Create Alert → Issue Alert, entorno `production`, destino tu correo y, si quieres el móvil, una integración de webhook hacia ntfy (la interfaz de Sentry cambia: confírmalo en su documentación):

1. **Incidencia nueva** (cualquier error que Sentry no hubiera visto): avisa a la primera vez.
2. **Ráfaga en dinero:** etiqueta `route` que empiece por `POST /api/orders`, `POST /api/shop/orders` o `POST /api/webhooks`, **3 o más eventos en 5 minutos** → aviso urgente (es la alerta 2 de la auditoría §4).
3. **Pasada de reconcile fallida:** etiqueta `reason` = `failed_pass` → aviso urgente.
4. **Regresión:** una incidencia resuelta que vuelve a aparecer.

Conviene dejar activada la protección contra picos de Sentry (viene por defecto): junto al tope de 20 capturas por minuto e instancia, evita agotar la cuota si cae la BD.

### 4.5 Cómo probar que funciona (sin rutas de prueba)

No existe ninguna ruta de prueba en el servidor ni debe añadirse. Se comprueba desde tu máquina con `scripts/observability-check.ts` (`npm run observability:check --`):

1. **Ensayo, sin red:** `npm run observability:check`. Monta el SDK real con un transporte que no envía e imprime el evento tal como saldría, a partir de un error con un email, un teléfono, un `Bearer` y un `t=` falsos. Debe terminar con «OK: ninguno de los datos personales falsos…». Si dice «FILTRACIÓN», no actives Sentry.
2. **Envío real (con tu DSN en el entorno o en `.env`):** `npm run observability:check -- --send`. Manda **un** evento con la etiqueta `tenant:prueba-observabilidad`; búscalo en Sentry (Issues) y comprueba que no lleva datos personales, ni Host, ni cabeceras.
3. **Alerta del operador:** `npm run observability:check -- --alert` (con `PLATFORM_ALERT_URL`). Manda **una** alerta de aviso con motivo `prueba_observabilidad`; debe llegarte al móvil al instante.
4. **Extremo a extremo en producción:** el aviso real más seguro es provocar un error en un entorno de pruebas (un cliente de pruebas con una clave de pasarela inválida: el reconcile da `failed_pass`). No se hace en producción con clientes reales.

Pruebas automáticas (la suite del front vacía `SENTRY_DSN`, `PLATFORM_ALERT_URL` y `PLATFORM_ALERT_TOKEN` en `vitest.config.mts`: nunca sale nada real aunque tu `.env` las tenga): `tests/lib/observability-*.test.ts`, `platform-alert.test.ts`, `alert-operator.test.ts`, `instrumentation.test.ts`, `tests/api/cron-reconcile-sentry.test.ts`, `tests/api/checkout-failure-sentry.test.ts` (front, con el SDK real y un transporte simulado), `packages/contracts/test/health-ops.test.ts` y `apps/control-panel/tests/ops-*.test.ts` (panel).

## 5 · Lo que no está verificado y riesgos residuales

- **Nada se ha enviado a un Sentry ni a un ntfy reales.** Lo verificado es el SDK real contra una ingesta local falsa (`next start` con un DSN a `127.0.0.1`) y contra transportes simulados en los tests; el formato de ntfy/Slack/Discord replica el del panel, que sí se ha probado con servicios reales.
- La **región UE** depende del DSN que crees; el código no lo comprueba. Los precios de Sentry no se han verificado.
- **Trazas minificadas** (ver arriba).
- El filtro de texto libre es de **último recurso**: un nombre propio o una dirección dentro del mensaje de una librería no se reconocen con expresiones regulares.
- El bloque `ops` lo produce otro paquete de trabajo: **hasta que se despliegue el front con `ops`, el panel no aplica ninguna regla** (no hay falsas alarmas, pero tampoco aviso). El panel y el front deben desplegarse en cualquier orden: ambos lados son compatibles hacia atrás.
- La memoria de las señales vive en un campo de texto (`TenantHealth.error`): un front que vuelva a una versión sin `ops` deja líneas conservadas hasta que se vuelva a medir, y un «recuperado» omitido por el tope de avisos no se reintenta. La opción robusta es una columna JSON en `TenantHealth` (migración del panel).
- `reconcile-payments` tiene 55 s de plazo en el panel (antes 20 s), por debajo de los 60 s del front: una pasada lenta ya no cuenta como fallo de la tarea, pero una llamada de 55 s ocupa más tiempo del presupuesto de la pasada del disparador (90 s), así que con muchos clientes lentos algunos esperan a la siguiente invocación (5 min).
- Conciliación pasarela → BD (alerta 1): con **SumUp** solo cubre el sentido BD → pasarela (no detecta un cobro SIN pedido; ver §3). Con Stripe no cubre cobros de más de 48 h ni los de los últimos 45 min, ni un pago parcial o un importe que no cuadre con el pedido (eso lo vigila `completeOrder`). **Orden de despliegue:** primero el front (trae la ruta) y luego el panel (trae la tarea): al revés, la tarea daría 404 y el panel avisaría de fallos seguidos hasta que el front se despliegue.
- Cobertura que **no** cierra este trabajo: monitor externo y canario sintético tras cada despliegue (OB-15).
