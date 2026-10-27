# Auditoría 05 · Confiabilidad operativa y observabilidad de La Grailla

Fecha: 2026-10-27 · Alcance: solo lectura del repo (`/Users/pablomunoz/Documents/la-grailla`) + documentación pública de Vercel. No se ha tocado producción, BD, `.env*` ni git.

Leyenda de confianza: VERIFICADO = leído en el código/doc citado; PROBABLE = se deduce del código pero depende de configuración o de un comportamiento de plataforma que no he podido observar; HIPÓTESIS = riesgo plausible sin evidencia directa.

---

## 0. Qué herramientas hay de verdad (y cuáles no)

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿Se usa **Harness** (SRM, Chaos, FFM, pipelines)? | **NO.** Ninguna referencia en el repo (`grep -ril harness` fuera de node_modules/.git/.next: 0 resultados). No se propone ninguna integración inventada: abajo se traduce a Vercel + GitHub Actions + el panel + monitor externo + Sentry. | grep |
| ¿Sentry u otra captura de errores? | **NO.** Solo aparece en docs como "no se usa" (`docs/platform/subida-next-15.md:15,65`). Tampoco Datadog, Logtail, Better Stack, PostHog, Speed Insights ni `@vercel/analytics` (grep del repo y de ambos `package.json`). | grep |
| ¿Métricas / traza / correlación? | No. Solo `console.error/log` de texto libre en español. No hay `requestId`/correlación en el código (`grep requestId|x-request-id`: 0). | grep |
| ¿Logs estructurados? | No. Excepción: `logRateLimited` (`lib/tenant/log.ts`) solo limita frecuencia, no estructura. | `lib/tenant/log.ts:7-21` |
| ¿Auditoría de acciones de admin? | **Panel: sí** (`AuditLog` con cadena de hashes y trigger anti-UPDATE/DELETE, `apps/control-panel/lib/audit.ts`). **Front (admin del cliente): no** (`grep auditlog` en `app/`, `lib/`, `prisma/`: 0). | grep |
| ¿Alertas? | **Solo infraestructura, en el panel** (`apps/control-panel/lib/services/alerts.ts`): salud no responde (2 fallos seguidos), tarea de cron falla 3 seguidas, web degradada, migración fallida, registro no publicable, refresco diario fallido; canales ntfy/Slack/Discord/email + latido a healthchecks.io (`HEARTBEAT_URL`). **Ninguna alerta de negocio** (pagos, emails, pedidos atascados). Los canales son opcionales y no puedo saber si están configurados en producción (`m9-primer-despliegue.md:171-177`). | alerts.ts, crons.ts |
| ¿Alertas por correo de dinero/aforo en el front? | Sí, pero **solo a `admin_email` del cliente y por el SMTP del cliente** (`paymentMatchesOrder`, `alertPaidButInactiveOrder`, `checkCapacityAlerts`). El operador de la plataforma no recibe nada. | `lib/reconciliation/shared.ts:16-66`, `lib/capacity-alerts.ts:20-87` |
| ¿Health checks? | `GET /api/health` (público: `{status}` 200/503; con secreto de cron del tenant: detalle de BD, esquema, `serving`, marca de tenant, onboarding). Panel `/health` + `TenantHealth` (solo **última** comprobación, sin histórico). | `app/api/health/route.ts:57-109`, `crons.ts:136-147` |
| ¿Crons? | (a) Vercel Cron del **panel**: `tenants` cada 5 min y `snapshots-refresh` diario 04:17 UTC (`apps/control-panel/vercel.json`); recorre tenants y llama a `reconcile-payments` (5 min), `cleanup-waiting-room` (30 min), `health` (5 min) con backoff por tenant y sin "cabeza de cola" (`crons.ts:19-23,79-225`). (b) **GitHub Actions legacy** (`reconcile-payments.yml` */5, `cleanup-waiting-room.yml` */30) apuntando solo a `www.lagrailla.es`. | ficheros citados |
| ¿Reintentos / DLQ / cola de emails? | Stripe reintenta webhooks (documentado en el código); el cron reconcilia PENDING cada 5 min (red de seguridad también para Stripe). **No hay cola ni DLQ de emails**: un único intento inline. `Order.emailAttempts/emailLastError/emailSentAt` registran el estado pero nada reintenta. | `lib/tickets.ts:299-309`, `reconciliation/entradas.ts:44-51` |
| ¿Despliegue/rollback? | Build `migrate deploy` en el proyecto antiguo; `build:platform` sin migrar; runner de migraciones desde el panel (manual, no en CI); `FRONT_MIN_SCHEMA` manual; CI con tsc+lint+vitest+builds+linter de migraciones. Sin smoke post-despliegue. | `scripts/build.js`, `.github/workflows/ci.yml` |

---

## 1. Lo que ya está bien (breve, con evidencia)

1. **Idempotencia de dinero**: transiciones `PENDING→COMPLETED` con `updateMany` condicionado (`reconciliation/entradas.ts:22-35`, `tienda.ts:16-19`); clave de idempotencia Stripe por pedido (`payment-adapter.ts:~236-240`) y de reembolso; `ProcessedWebhookEvent` insertado **después** de procesar (PAY-05, `webhook-handler.ts:66-76`), así un fallo transitorio se reintenta.
2. **Verificación de importe** cobrado vs pedido y alerta (`shared.ts:16-47`), y alerta por pago sobre pedido ya anulado (`shared.ts:50-66`).
3. **Reconcile con cola justa** (`reconcileCheckedAt nulls first`, `route.ts:36-39`), sellada antes de llamar a pasarela, 502 si una pasada entera solo da errores (`route.ts:215-229`). Corre cada 5 min por tenant con su secreto derivado; un tenant que falla no frena a los demás (`crons.ts:7-15`).
4. **El disparador del panel falla en voz alta**: HTTP 500 si falla alguna tarea o hay vencidas sin lanzar (`crons.ts:232-236`), latido a servicio externo si el propio panel cae (`alerts.ts:130-141`, `dispatch/route.ts`), tope de 10 avisos por pasada y resumen (`crons.ts:41,110-121,217-223`). Avisa del **cambio** de estado, no cada 5 min.
5. **`/api/health` honesto**: 503 `maintenance` si el tenant está bloqueado por esquema (no "ok" falso) y 503 si la BD pertenece a otro tenant (`health/route.ts:73-83`), con detección de deriva de esquema en el panel (`health.ts:50-53`). Log de arranque de variables mal puestas (`lib/tenant/env-check.ts`).
6. **Aislamiento y degradación**: registro firmado, sirviendo "lo último bueno" hasta 6 h con log `[tenant-resolve] sirviendo obsoleto` (`m4-runtime.md:92`), webhooks y crons nunca cortados por licencia.
7. **Sin sobreventa verificada** con k6 (`loadtest/README.md`): 300 compradores vs 200 entradas, 0 sobreventa (solo local; ver OB-16).
8. **Disciplina de migraciones**: solo aditivas, linter en CI, `lock_timeout` 3 s, runner con canario, parada ante fallo, `MigrationRun` + auditoría (`m7-operacion.md:176-197`).
9. **Ensayo P3/P4/P5 hecho en infra real** (`m8-ensayo.md:116-118`): cron real cada 300 s con 200 y `failed=0`.

---

## 2. Hallazgos

Resumen: **6 × P0, 10 × P1, 6 × P2**.

### P0 — un fallo transaccional puede pasar sin que nadie se entere / riesgo de dinero

#### OB-01 · P0 · El cron de reconciliación toma un error de pasarela por "pedido aún pendiente" (y a las 24 h cancela pedidos que pudieron estar pagados)
- **Problema.** `StripeAdapter.verifyPayment` captura **toda** excepción y devuelve `{success:false, error}` **sin `status`**; `SumUpAdapter.verifyPayment` devuelve `status:'UNKNOWN'` ante un HTTP no-ok. El cron solo distingue `success`, `status==='EXPIRED'` y "lo demás" → "lo demás" suma a `stillPending`, no a `errors`. La salvaguarda `failedPass` (502 si todo son errores) solo se activa con **excepciones**, que estos adaptadores no lanzan.
- **Evidencia.** `lib/payment-adapter.ts:263-264` (`catch (err) { return { success: false, … error } }`); `:376-388` (`response.ok ? mapSumUpStatus : 'UNKNOWN'`); `app/api/cron/reconcile-payments/route.ts:128-135` (`else { stillPending += 1 }`), `:215` (`failedPass = errors > 0 && completed+released+stillPending === 0`). El campo `error` del resultado **nunca se registra**. En el bucle de "abandonados" (>24 h) cualquier `!result.success` cae a `releaseExpiredOrder` (`route.ts:145-157`, `:192-202`).
- **Escenario.** El cliente rota o pega mal la clave de SumUp/Stripe (el propio código dice que "ya hemos visto fallar esto en producción", `payment-adapter.ts:~320-324`), o Stripe/SumUp tienen una caída. Cada pasada responde **200**, el panel marca la tarea "ok", ninguna alerta salta, y los pedidos SumUp (que no tienen webhook) quedan en PENDING. A las 24 h `releaseExpiredOrder` cancela el pedido y libera el aforo aunque el comprador haya pagado; después, nada lo detecta porque `alertPaidButInactiveOrder` solo se invoca desde `completeOrder` (el webhook de Stripe o el propio cron sobre PENDING), y SumUp nunca llama de nuevo.
- **Impacto.** Cobro sin entrada; el comprador reclama a soporte días después; devolución manual; entradas vendidas dos veces. Es la raíz de la categoría "pago cobrado sin pedido confirmado".
- **Solución.** (1) Que `verifyPayment` distinga `status:'ERROR'` (fallo de consulta) de `PENDING`/`UNKNOWN`; el cron lo cuenta en `errors` y lo registra con `error` y tenant. (2) **Nunca** liberar/cancelar en el bucle de abandonados si la verificación falló: solo si la pasarela confirma `EXPIRED/FAILED/PENDING-sin-pago` de forma explícita; ante `ERROR`, dejar PENDING y alertar. (3) Devolver en el JSON del cron `{errors, errorSamples[]}` y que el panel (OB-06) alerte con `errors>0` 3 pasadas seguidas. (4) Verificación periódica de credenciales con `testConnection()` (ya existe en ambos adaptadores) dentro del health profundo (OB-06).
- **Esfuerzo.** S–M. **Confianza.** VERIFICADO.

#### OB-02 · P0 · Las alertas de dinero (importe no cuadra, pago sobre pedido anulado) solo salen por el SMTP del cliente y al correo del cliente
- **Problema.** `paymentMatchesOrder` y `alertPaidButInactiveOrder` envían por `sendMail` (SMTP **del cliente**) a `getOperatorEmail` (el `admin_email` del cliente; vacío en modo plataforma si no lo configuró → solo log). Si el SMTP del cliente está caído o mal configurado —precisamente el escenario de OB-04— la alerta de dinero desaparece con un `console.error`. El operador de la plataforma no es destinatario.
- **Evidencia.** `lib/reconciliation/shared.ts:27-45` (rate-limit 1/día/pedido + `sendMail`), `:50-65` (`if (!to) return; // cliente sin admin_email: solo queda el log`), `lib/config.ts:~107-119` (`getOperatorEmail`). Además `lib/mailer.ts:60-93` devuelve `success:false` sin lanzar y el llamante solo comprueba excepciones.
- **Escenario.** Pago de 1 € sobre pedido de 25 € con SMTP caducado: el pedido no se completa, "se avisa" a nadie, el comprador paga y no recibe nada.
- **Impacto.** Pérdida de dinero/reembolsos tarde; incidente invisible para el equipo que sí vigila.
- **Solución.** Canal propio de la plataforma, independiente del SMTP del cliente: el front hace `POST` firmado a un endpoint de ingesta del panel (o directamente a un webhook ntfy/Slack del operador) con `{tenantId, tipo, orderId}` sin PII, y el panel lo trata con su `notify()` existente. Mantener el correo al cliente como complemento. Mismo canal para "pedido pagado no confirmado" (OB-03) y "email de entradas sin enviar" (OB-04).
- **Esfuerzo.** M. **Confianza.** VERIFICADO.

#### OB-03 · P0 · El webhook devuelve 200 y se marca "procesado" cuando el `orderId` no existe en esa BD
- **Problema.** `resolvePaidCheckout` devuelve `null` si el pedido no está en `Order` ni en `ShopOrder`; el handler ignora el valor de retorno, inserta `ProcessedWebhookEvent` y responde `{received:true}`. Sin log ni alerta.
- **Evidencia.** `lib/order-reconciliation.ts:9-21` (`return null`), `lib/payments/webhook-handler.ts:64` (`await resolvePaidCheckout(...)` sin usar el resultado) y `:72` (se registra como procesado).
- **Escenario.** Multi-cliente: el endpoint de Stripe de un cliente apunta por error al dominio de otro (la firma no valida y da 400, pero si comparten cuenta de Stripe o el `whsec` se copió, valida), o el pedido se borró/migró de BD, o el `orderId` de metadata no coincide. El cobro existe en Stripe, no hay pedido, el evento queda "procesado" para siempre.
- **Impacto.** "Cobro sin pedido" silencioso, imposible de encontrar sin cruzar Stripe contra BD a mano.
- **Solución.** Si el resultado es `null`: log estructurado `webhook.order_not_found` con tenant/provider/eventId, **no** registrar como procesado (que Stripe reintente) y alerta crítica por el canal de OB-02. Complementar con la conciliación diaria pasarela↔BD (OB-11).
- **Esfuerzo.** S. **Confianza.** VERIFICADO.

#### OB-04 · P0 · El email de entradas falla sin reintento ni aviso; la tienda ni siquiera registra si se envió
- **Problema.** Entradas: `completeOrder` envuelve `sendTicketsEmail` en `try/catch` que solo hace `console.error`; el webhook responde 200 y registra el evento como procesado; el cron solo mira PENDING; **no hay cron de reenvío**. El estado queda en `Order.emailSentAt=null`/`emailLastError` (visible solo si un admin abre `/admin/ventas`, `app/admin/ventas/page.tsx:341,429-433`). Tienda: `completeShopOrder` solo hace `console.error` y `ShopOrder` **no tiene** campos de email: sin estado, sin reintento, sin superficie en admin.
- **Evidencia.** `lib/reconciliation/entradas.ts:44-51`, `lib/tickets.ts:299-309`, `lib/reconciliation/tienda.ts:42-67`, `prisma/schema.prisma:254-295` (campos de email solo en `Order`), `:370-399` (`ShopOrder` sin ellos). El correo de entradas es lo único que entrega el QR salvo que el comprador vuelva a `/confirmacion`.
- **Escenario.** El cliente cambia la contraseña del SMTP, o su proveedor limita envíos. Cada compra completa y cobra, nadie recibe entradas, y el cliente solo se entera cuando escriben los compradores el día del evento.
- **Impacto.** Soporte reactivo, reputación; es el fallo transaccional más probable de la plataforma (SMTP de terceros).
- **Solución.** (1) Sweeper en el cron de reconcile (ya corre cada 5 min): `Order COMPLETED AND emailSentAt IS NULL AND emailAttempts < 5 AND updatedAt < now-2min` → reintento con backoff; índice `[status, emailSentAt]` ya existe. (2) Añadir `emailSentAt/emailAttempts/emailLastError` a `ShopOrder` (migración aditiva) y mismo sweeper. (3) Contador `emailFailed` en el health detallado (OB-06) con alerta por tenant si `>0` durante 15 min. (4) `transporter.verify()` en el health profundo para pillar el SMTP caducado antes de la primera compra.
- **Esfuerzo.** M. **Confianza.** VERIFICADO.

#### OB-05 · P0 · No hay captura de errores ni alerta de 5xx en la ruta de compra y los webhooks del front
- **Problema.** Sin Sentry ni equivalente; los errores de rutas de dinero van a `console.error` de Vercel. Retención de runtime logs: **Hobby 1 h, Pro 1 día, Pro+Observability Plus 30 días** (doc Vercel). Las alertas nativas de Vercel (error anomaly por ruta, 5xx) requieren **Observability Plus**. El panel solo vigila `/api/health` cada 5 min: un `POST /api/orders` que da 500 con BD sana no se ve.
- **Evidencia.** Ausencia de Sentry (grep); `lib/api-error.ts:5-6` (`console.error('[ctx]', error)` y 500 genérico); `app/api/orders/route.ts:365,389`, `app/api/shop/orders/route.ts:200`, `payments/webhook-handler.ts:85`. Vercel docs: https://vercel.com/docs/logs/runtime (retención), https://vercel.com/docs/alerts (alertas = Pro con Observability Plus).
- **Escenario.** Un bug del release del jueves hace fallar el checkout de un tenant concreto (p.ej. columna nueva ausente → P2022, o pool agotado → P2024). Health sigue verde. Pasan horas hasta que un cliente avisa; si la retención es de 1 día, el log ya no está el lunes.
- **Impacto.** Ventas perdidas sin señal; imposibilidad de post-mortem.
- **Solución.** (1) Verificar hoy en el dashboard que **Observability Plus está activo** (para equipos Pro creados/actualizados desde 2026-04-03 viene por defecto) y crear alertas de error anomaly + monitores personalizados sobre `/api/orders`, `/api/shop/orders`, `/api/webhooks/*`, `/api/cron/*`. (2) Sentry (SDK Next 15 con `instrumentation.ts` + `onRequestError`) con tag `tenant` (de `currentTenant()`), `beforeSend` que elimine cuerpos/emails, y regla "cualquier error en rutas de dinero → ntfy". (3) Log Drain (Pro) a un destino barato para retención >30 d (OB-13).
- **Esfuerzo.** M. **Confianza.** VERIFICADO (ausencia) / PROBABLE (estado real del plan en su cuenta).

#### OB-06 · P0 · El panel no recibe ninguna señal de negocio: sin ella, OB-01…OB-05 no tienen dónde alertar
- **Problema.** El detalle de `/api/health` y `HealthDetailSchema` solo llevan BD/esquema/onboarding. El cron de reconcile devuelve `{checked, completed, released, stillPending, errors}` pero el panel descarta el cuerpo (`CronState` guarda solo `lastHttp/lastStatus/lastError/lastDurationMs`). No se mide edad del pedido PENDING más antiguo, emails sin enviar, pedidos COMPLETED sin QR, escaneos `PENDING_PAYMENT`, ni validez de credenciales de pasarela/SMTP.
- **Evidencia.** `app/api/health/route.ts:94-108` (campos devueltos), `apps/control-panel/lib/services/health.ts:10-22` (esquema Zod), `crons.ts:149-153` (solo status HTTP), `apps/control-panel/prisma/schema.prisma` modelos `CronState`/`TenantHealth`.
- **Solución (la pieza que desbloquea las alertas).** Añadir un bloque `ops` al health **autenticado** (solo lectura, sin PII, consultas indexadas): `oldestPendingOrderAgeMin`, `pendingOrders`, `emailFailedCount`, `completedWithoutEmailMin`, `shopPaidNoEmail`, `scanPendingPaymentLast1h`, `gatewayCredOk` (`testConnection()` cacheado 15 min), `smtpOk` (`verify()` cacheado), `oldestWaitingMin`, `lastReconcileErrors`. El panel guarda el último `ops` en `TenantHealth` y alerta por umbrales con el motor ya existente (cambio de estado, una sola vez, tope de 10). Es la solución más barata porque reutiliza ntfy, el latido y el backoff.
- **Esfuerzo.** M. **Confianza.** VERIFICADO.

### P1 — gaps, semana 1

#### OB-07 · P1 · SMTP sin timeouts, inline en el webhook, y un fallo de BD se disfraza de "No hay SMTP configurado"
- **Problema.** `nodemailer.createTransport` sin `connectionTimeout/greetingTimeout/socketTimeout` (los valores por defecto de la librería son del orden de minutos); se ejecuta **dentro** del webhook de Stripe junto al PDF y un `.pkpass` por entrada, y el route del webhook no declara `maxDuration` (solo `send-tickets` e `invitations` lo hacen, `grep maxDuration`). `getSmtpSettings` captura cualquier error y `sendMail` responde `'No hay SMTP configurado'`.
- **Evidencia.** `lib/mailer.ts:52-93`, `lib/tickets.ts:176-258`, `app/api/webhooks/**` sin `maxDuration`.
- **Escenario.** SMTP del cliente colgado: el webhook tarda hasta el timeout de la función, Stripe reintenta; si la función muere tras enviar pero antes de grabar `emailSentAt`, el reintento reenvía (doble email) con adjuntos. Un pico de errores de BD aparece en `emailLastError` como "No hay SMTP configurado" y se diagnostica mal.
- **Solución.** Timeouts explícitos (p.ej. 10/10/20 s); sacar PDF+email del camino crítico del webhook (el webhook solo confirma el pedido; el email lo envía el sweeper de OB-04 o `after()`/`waitUntil`); propagar el error real de BD; `maxDuration` en webhooks y reconcile.
- **Esfuerzo.** S–M. **Confianza.** PROBABLE (depende de los timeouts por defecto de nodemailer y del `maxDuration` efectivo del proyecto).

#### OB-08 · P1 · `getConfig*` traga los errores de BD y devuelve el valor por defecto, sin log
- **Evidencia.** `lib/config.ts:~147-156,~158-166,~177-190` (`catch { return configDefault(key); }`).
- **Escenario.** Un `P2024` (pool) o arranque en frío de Neon hace que `getConfigOrThrow('stripe_secret_key')` devuelva `''` → `ProviderNotConfiguredError` → el webhook responde **400** "Stripe no está configurado" (`webhook-handler.ts:38-44`) y se registra como problema de configuración, no de BD; `payment_gateway` vacío cae a `mock` y en producción lanza otro error engañoso. Los reintentos de Stripe lo salvan, pero el diagnóstico y la métrica de "fallos de configuración" quedan falseados.
- **Solución.** Distinguir "no hay fila" de "error de BD": ante error de BD, log con tenant y relanzar en las rutas de dinero.
- **Esfuerzo.** S. **Confianza.** VERIFICADO (código) / PROBABLE (escenario).

#### OB-09 · P1 · Alertas de aforo 80/95/100 con `void` fire-and-forget (sin `waitUntil`/`after`)
- **Problema.** En `scan`, `taquilla/sale` y `orders` (modo sin pasarela) se llama `void checkCapacityAlerts(...)` y se responde; en serverless la función puede congelarse tras la respuesta, perdiéndose el envío. En modo plataforma, además, el contexto del tenant (cabecera firmada) debe sobrevivir a la respuesta. La ruta del webhook sí hace `await`, así que online con pasarela funciona. No hay `waitUntil` ni `after` en todo el repo.
- **Evidencia.** `app/api/scan/route.ts:172`, `app/api/taquilla/sale/route.ts:172`, `app/api/orders/route.ts:328`, grep `waitUntil|after(` = 0.
- **Impacto.** El aviso de "95 %/100 %" de venta en taquilla/puerta no llega de forma fiable (y no se reintenta salvo en la siguiente venta, porque `alertsSent` solo se graba si el envío tiene éxito: `capacity-alerts.ts:80-83`).
- **Solución.** `import { after } from 'next/server'` (Next 15) o `waitUntil` de `@vercel/functions`.
- **Esfuerzo.** S. **Confianza.** PROBABLE.

#### OB-10 · P1 · El cron de reconcile es secuencial, sin `maxDuration`, y el panel corta a los 20 s
- **Problema.** Hasta 200 pedidos por pasada (4 lotes de 50), verificados **uno a uno** contra la pasarela; el route no fija `maxDuration`; el panel llama con `timeout 20 s` (`DEFAULT_CALL_TIMEOUT_MS`) y lo anota como fallo ("timeout") con backoff exponencial hasta 15 min. SumUp `createCheckoutSession`/`verifyPayment` no tienen `AbortSignal` (solo el reembolso), y Stripe usa los timeouts por defecto del SDK.
- **Evidencia.** `route.ts:51-90,121-210`; `crons.ts:29,149`; `payment-adapter.ts:349,380` (fetch sin signal) vs `:405,422`.
- **Escenario.** Tras una caída de la pasarela se acumulan >60 pedidos; la siguiente pasada tarda >20 s, el panel la marca fallida y alerta "falla", mientras la función de fondo sigue o muere a medias; el backoff retrasa justo el cobro que hay que confirmar.
- **Solución.** Paralelismo acotado (5) o presupuesto de tiempo propio en el route (parar a los 15 s y devolver `deferred`); `maxDuration = 60`; `AbortSignal.timeout(10_000)` en todas las llamadas a pasarela; que el panel distinga "timeout con avance" de "fallo".
- **Esfuerzo.** S–M. **Confianza.** PROBABLE.

#### OB-11 · P1 · No existe conciliación pasarela↔BD ni marca de "pagado a las"
- **Problema.** Solo se verifica lo que existe como pedido PENDING con `paymentId` en las últimas 24 h. No hay un recorrido **desde la pasarela** (`checkout.sessions.list`, transacciones SumUp) hacia la BD. Y `Order` no guarda `paidAt`: no se puede medir pagado→email, ni la latencia de confirmación, ni la edad real del pago (`updatedAt` cambia al grabar el email).
- **Evidencia.** `schema.prisma:254-282` (sin `paidAt`), `route.ts:51-90`.
- **Casos ciegos concretos.** (a) `paymentId` nulo tras `createCheckoutSession` si falla el `order.update` de `orders/route.ts:~354` (SumUp: sin webhook, el pedido se libera a las 24 h aunque se pague). (b) Pago SumUp posterior a la liberación: nadie lo ve. (c) OB-03.
- **Solución.** Job diario de solo lectura por tenant: sesiones Stripe pagadas últimas 48 h sin `Order/ShopOrder` COMPLETED/PAID con ese `paymentId` → alerta; idem SumUp. Añadir `paidAt` (migración aditiva) y `ops.unmatchedPayments` al health. Esto además es el SLI de "cobros sin pedido".
- **Esfuerzo.** M. **Confianza.** VERIFICADO.

#### OB-12 · P1 · Sin auditoría de acciones de admin en el front del cliente
- **Problema.** Reembolsos, anulaciones, cambio de pasarela/claves/SMTP, cambio de roles, borrados: no queda traza de quién ni cuándo (el panel sí tiene `AuditLog` con cadena de hashes).
- **Evidencia.** `grep auditlog|activitylog` en `app/ lib/ prisma/` = 0; `invalidateOrder` solo cambia estados (`reconciliation/entradas.ts:106-200`).
- **Impacto.** En una disputa de reembolso, un cambio de claves de pago o un fraude interno no hay forma de reconstruir qué pasó; además, cambiar `payment_gateway` a `mock` o rotar el SMTP es justo lo que rompe las ventas.
- **Solución.** Tabla `AdminAuditLog` (append-only por convención) con `actorId, action, targetType, targetId, meta` (sin secretos, reutilizando `assertNoSecrets` del panel) para: refund/cancel, `setConfig` de claves sensibles (solo "clave X modificada"), roles, borrados. Sale en el health como `lastConfigChangeAt`.
- **Esfuerzo.** M. **Confianza.** VERIFICADO.

#### OB-13 · P1 · Logs sin estructura, sin tenant/pedido/correlación consistentes y con riesgo de PII
- **Problema.** Texto libre; el cron sí etiqueta `[cliente X]` (`reconcile-payments/route.ts:47`) pero `handleApiError`, `completeOrder`, `paymentMatchesOrder`, `mailer` no. `handleApiError` imprime el objeto de error completo: los errores de Prisma llevan el nombre del modelo y a menudo valores de la consulta (emails de compradores) y el stack. Typos que rompen búsquedas (`Errorverificando`, `Errorliberando`, `route.ts:~143,~166`). El tenant solo se deduce del `host` de la línea de petición de Vercel (aceptable, pero no en los logs de tareas internas).
- **Evidencia.** `lib/api-error.ts:5-6`; `lib/mailer.ts:82,88`.
- **Solución.** Un `log(level, event, {tenantId, orderId, provider, requestId})` que emita JSON de una línea; `event` estable (`webhook.order_not_found`, `email.send_failed`, `reconcile.pass`) para filtros y métricas; redactor de emails/PII; en Sentry, `beforeSend`. Los Log Drains de Vercel entregan `requestId` y `host` (https://vercel.com/docs/drains/reference/logs).
- **Esfuerzo.** M. **Confianza.** VERIFICADO.

#### OB-14 · P1 · Riesgos de despliegue
- **Problema (a) — Preview del proyecto antiguo migra la BD real.** Mientras el proyecto antiguo siga en modo normal sin `SKIP_MIGRATE_ON_BUILD=1`, cualquier build (incluidas Previews) ejecuta `prisma migrate deploy` contra la BD configurada. Ya ocurrió: "las aplicó una Preview del proyecto antiguo" (`m8-ensayo.md:116`).
- **(b) `FRONT_MIN_SCHEMA` a mano y por tenant:** si se despliega código que usa una columna nueva sin haber migrado a un tenant, ese tenant queda en 503 "mantenimiento" **incluyendo webhooks y crons** (`m7-operacion.md:205`): los pagos en vuelo dependen del reintento de Stripe y SumUp se retrasa hasta que se migra. Es correcto como seguridad, pero un release en pleno on-sale convierte "migración pendiente" en "caída de ventas".
- **(c) El runner no corre en CI y no hay ventana de ventas conocida** (`m7-operacion.md:195-197`): migraciones con bloqueos largos pueden coincidir con una venta; `lock_timeout` 3 s mitiga pero hace fallar la migración, no el tráfico.
- **(d) Sin smoke post-despliegue por tenant:** CI compila y prueba, pero nada comprueba tras el deploy que `/`, `/eventos/<slug>/comprar`, `/api/health` y un `POST /api/orders` (mock/test mode) responden por tenant. Sin migración "N-1/N+1" matriz (`m7-operacion.md:307`).
- **(e) Rollback:** código = Instant Rollback de Vercel (restaura también el `vercel.json` de crons del despliegue); esquema = "no hay down; se corrige hacia delante" (`m7-operacion.md:193`). Con migraciones solo aditivas el rollback de código es seguro **mientras se mantenga expand/contract**; el riesgo es el release "contract" (destructivo) y que `FRONT_MIN_SCHEMA` suba antes de poder volver atrás.
- **(f) Deploy durante una venta:** las funciones en curso no se cortan, pero las `$transaction` de compra esperan hasta 20 s por el advisory lock; un cold start masivo tras deploy con cientos de compradores en cola puede saturar el pool de Neon (ver OB-16). No hay "congelación de despliegues" automática (Ignored Build Step o promoción manual) mencionada como obligatoria salvo en el corte.
- **Solución.** Poner `SKIP_MIGRATE_ON_BUILD=1` en el proyecto antiguo **y** desactivar migraciones en Preview; congelación de despliegues por calendario (variable `SALES_FREEZE` en un Ignored Build Step o promoción manual) cuando haya evento con venta abierta o sala de espera activa; smoke post-deploy (workflow `deployment_status` que lance el canario de OB-15 contra cada tenant y bloquee la promoción si falla); `migrate:tenants` siempre con `--canary` y fuera de ventana (el runner debería consultar `ops.openSalesWindow` y negarse).
- **Esfuerzo.** M. **Confianza.** VERIFICADO (a, b, c) / PROBABLE (d, e, f).

#### OB-15 · P1 · Sin monitor externo ni canario sintético; el panel es el único vigilante (y es un punto único)
- **Problema.** `TenantHealth` guarda solo la última comprobación: no hay histórico, ni uptime %, ni SLO medible. Vercel Cron es "best effort": una invocación perdida **no genera log** (doc Vercel) y las duplicadas son posibles; el propio panel puede caer. El latido (`HEARTBEAT_URL`) lo cubre solo si está configurado (opcional, `m9-primer-despliegue.md:171-177`). La recomendación de "monitor externo" del runbook de despliegue está como recomendación, no como requisito cumplido. `/api/health` público solo prueba `SELECT 1`: no prueba renderizar la ficha de evento, ni que Stripe acepte la clave, ni que el SMTP conecte.
- **Evidencia.** `health.ts:97` (upsert, sin histórico), doc cron: https://vercel.com/docs/cron-jobs/manage-cron-jobs ("Cron delivery is best effort…").
- **Solución.** Ver §5 (alertas) y §6: monitor externo con ≥2 comprobaciones por tenant (health + página de compra con keyword), latido de healthchecks.io verificado, y canario sintético post-deploy.
- **Esfuerzo.** S (monitor) + M (canario). **Confianza.** VERIFICADO.

#### OB-16 · P1 · Pool de conexiones Neon y picos de venta: sin medir en infra real
- **Problema.** `connection_limit=3` y `pool_timeout=10 s` por cliente e instancia (`lib/tenant/db.ts:25-29`); la compra mantiene una transacción interactiva de hasta 20 s esperando un advisory lock **por evento** (`orders/route.ts:169,282-283`) y además cada petición escribe en `RateLimitBucket` en la misma BD (`rate-limit.ts:62-76`). Con N instancias concurrentes, cada tenant puede abrir 3·N conexiones; el 4º en la misma instancia espera hasta 10 s y falla con `P2024` → `handleApiError` → 500 genérico. El README de loadtest dice textualmente que los números locales no sustituyen probar Vercel+Neon (`loadtest/README.md` final) y el ensayo m8 no incluye carga (P1–P7).
- **Escenario.** Apertura de venta de un evento popular: 300 compradores + sala de espera; picos de `P2024` y `P2028`; el usuario ve error y reintenta, empeorando.
- **Solución.** Ejecutar `loadtest/race.js` y `checkout-flow.js` contra el entorno de pruebas (Vercel+Neon real) antes de la primera venta real y registrar p95/errores; alertar `P2024/P2028/P1001` como evento propio (OB-13); sala de espera obligatoria en ventas con aforo <5×compradores esperados; subir `connection_limit` solo con pooler (PgBouncer de Neon) comprobado (P2 del ensayo ya cubre advisory lock vía pooled).
- **Esfuerzo.** M. **Confianza.** HIPÓTESIS (mecánica verificada, magnitud sin medir).

### P2 — roadmap

#### OB-17 · P2 · Sala de espera: sin detección de cola atascada
`sweepAndAdmit` depende de que alguien haga polling (`app/api/queue/status/route.ts`), y el cron solo borra COMPLETED/EXPIRED (`lib/waiting-room.ts:21-29`). Si el aforo se bloquea por `ADMITTED` que no compran (ventana de 300 s) la cola avanza, pero nadie mide cuántos esperan ni cuánto. Solución: `oldestWaitingMin`, `admittedExpiredRatio` en `ops` (OB-06), alerta si `oldestWaiting > 20 min` con `waitingRoomEnabled`. S. HIPÓTESIS.

#### OB-18 · P2 · Sin datos de campo de rendimiento (LCP/CLS/INP) en las páginas de compra
No hay Speed Insights ni analytics. Speed Insights gratuito da solo Real Experience Score con 10 000 eventos/30 días compartidos y **pausa la recogida** al superarlo; Plus cuesta 10 $/proyecto/mes + 0,65 $/10 000 eventos y habilita CWV completos y Drains (https://vercel.com/docs/speed-insights/limits-and-pricing). La plataforma es **un** proyecto Vercel con N dominios: confirmar si se puede filtrar por host (HIPÓTESIS); alternativa: `web-vitals` + `sendBeacon` a una ruta propia con `tenantId`, muestreo 10 %. Mientras tanto, Lighthouse CI sintético en el canario. S–M.

#### OB-19 · P2 · Costes sin alertas
Optimización de imágenes (apagada por defecto, <4 $/mes estimado con 15 clientes, `optimizacion-imagenes.md:27`), Blob (almacén compartido con prefijo por tenant, limpieza en `blob-cleanup.ts`; sin informe de bytes por tenant), Neon (cómputo; el cron de 5 min impide la suspensión y consume horas, `m8-ensayo.md:367`), Drains (0,50 $/GB). Activar **Spend Management** de Vercel con webhook (Pro) y un informe mensual por tenant en el panel (bytes Blob por prefijo, filas). S.

#### OB-20 · P2 · Escáner de puerta: dependencia de red y rechazos no registrados
`/api/scan` exige red + sesión + BD por cada lectura; un QR desconocido (`INVALID`) responde sin escribir `ScanLog` (requiere `ticketId`, `scan/route.ts:~47-53`), así que la tasa de rechazo real es inobservable. No he verificado si `/acceso` tiene modo offline (no lo encontré en los ficheros revisados). Solución: log de `INVALID` en tabla propia o en el log estructurado; plan de contingencia de puerta (lista imprimible/exportación `export?type=tickets`). S–M. PROBABLE.

#### OB-21 · P2 · Detalles del disparador del panel
(a) Sin candado: dos invocaciones solapadas (Vercel puede duplicar o solapar, doc cron) ejecutan la misma tarea a la vez (idempotente, pero doble aviso posible). (b) El aviso sale cuando `failures === threshold`; si ese envío falla (ntfy caído) no se repite nunca (`crons.ts:186-187`). (c) "Éxito" de `reconcile-payments` = HTTP 2xx (ver OB-01). (d) `health` solo notifica degradación si `probe.reachable && previous` (`crons.ts:139-143`): la primera comprobación de un tenant ya degradado no avisa. Solución: `pg_try_advisory_lock` en el dispatcher y reenvío del aviso crítico a las 24 h. S.

#### OB-22 · P2 · Workflows de GitHub legacy duplicados
`reconcile-payments.yml` y `cleanup-waiting-room.yml` llaman solo a `www.lagrailla.es` con `CRON_SECRET` global; coexisten con el disparador del panel (idempotentes). Los fallos de Actions solo avisan por el correo de GitHub; los `schedule` de GitHub pueden retrasarse o saltarse (lo dice el propio `m7-operacion.md:209`). Retirarlos tras unos días limpios (ya previsto) y no depender de ellos. S.

---

## 3. Puntos ciegos de fallos transaccionales (mapa)

| Qué falla en silencio | Hoy | Hallazgo |
|---|---|---|
| Webhook devuelve 200 y no procesa (pedido inexistente) | Sí, y lo marca procesado | OB-03 |
| Pago cobrado sin pedido confirmado | Solo se detecta si hay PENDING con `paymentId` en 24 h; sin conciliación inversa | OB-01, OB-11 |
| Credencial de pasarela caducada/mal guardada | Cron "ok", pedidos PENDING→cancelados a las 24 h | OB-01 |
| Email de entradas falla | `console.error`; sin reintento; tienda sin estado | OB-04 |
| Alerta de dinero por SMTP caído | Se pierde | OB-02 |
| PDF/QR no se genera | `try/catch`: se envía el email sin PDF (`tickets.ts:176-185`), solo log | OB-04/13 |
| Reconcile no corre / panel caído | Latido (si configurado); cron Vercel best effort | OB-15, OB-21 |
| Reconcile "corre" pero tarda >20 s | Marcado como fallo, backoff | OB-10 |
| Cola de sala de espera atascada | No se mide | OB-17 |
| Límite de conexiones Neon / `P2024` | 500 genérico sin métrica | OB-16 |
| Timeouts serverless en exportaciones | Exports acotados (`take 5000/10000`, `export/route.ts`) pero sin `maxDuration` | P2, bajo riesgo |
| SMTP del cliente caído | `emailLastError` solo en admin | OB-04/07 |
| Migración pendiente deja un tenant en mantenimiento | Sí se ve: health 503 `maintenance`, panel "Falla" y alerta (bien hecho) | ya cubierto, ver OB-14 |
| Alertas de aforo perdidas | `void` sin `waitUntil` | OB-09 |
| Cambios de configuración de pago/SMTP sin traza | Sin auditoría | OB-12 |

---

## 4. SLIs y SLOs (barrera de calidad para las ventas)

Convención: ventana móvil de 30 días **por tenant**, y una ventana "on-sale" (las 2 h tras abrir una venta o con sala de espera activa) donde los objetivos son más estrictos. Con tráfico bajo (2-15 clientes) se exige un **mínimo de eventos** (p. ej. ≥20 pedidos en la ventana) para evaluar un ratio; por debajo, se vigilan conteos absolutos (un solo fallo ya es alerta).

Estado: **HOY** = calculable con lo que existe (SQL de solo lectura en la BD del tenant o datos de Vercel), pero **no está expuesto al panel**; **NUEVO** = requiere instrumentación. La columna "Fuente" dice de dónde sale el dato en este stack.

| # | SLI | Fórmula | Fuente | Objetivo / ventana | ¿Hoy? |
|---|---|---|---|---|---|
| S1 | Éxito técnico del checkout (entradas y tienda) | 1 − (respuestas 5xx de `POST /api/orders`, `POST /api/shop/orders` incl. 502 "no se ha podido iniciar el pago") / (todas las no-4xx) | Vercel Observability (route + status por host) o Log Drain; con Sentry, por tenant | ≥ 99,5 % 30 d; ≥ 99,9 % en on-sale | **HOY** en Vercel (necesita Plus para desglose; por tenant vía host). Sin alerta aún |
| S2 | Conversión de pedidos creados a pagados (indicador, no SLO) | `COMPLETED+PAID` / (`COMPLETED+PAID+CANCELLED`+`PENDING` con >30 min), `channel='ONLINE'` | BD: `Order.status`, `ShopOrder.status` | Seguimiento; alerta si cae >50 % vs media 7 d | **HOY** (SQL) |
| S3 | Latencia p95 de creación de pedido | p95 de duración de `POST /api/orders` | Vercel (p75 con Plus; p95 requiere Drain o línea de log con `durationMs`) | p95 ≤ 1,5 s normal, ≤ 4 s en on-sale (incluye lock hasta 20 s) | Parcial: p75 **HOY**; p95 **NUEVO** (log `order.created durationMs`) |
| S4 | Edad máxima de pedido en PENDING con `paymentId` | `max(now − createdAt)` de `Order/ShopOrder` PENDING con `paymentId` y `createdAt > 2 min` | BD (índice `[paymentId]`, `status`) | ≤ 15 min (Stripe) / ≤ 20 min (SumUp) el 99 % del tiempo; alerta duro a 30 min | **HOY** (SQL) → **NUEVO** exponerlo en `ops` (OB-06) |
| S5 | Cobros sin pedido confirmado | nº de sesiones pagadas en la pasarela (últimas 48 h) sin `Order/ShopOrder` COMPLETED/PAID con ese `paymentId` | Job de conciliación diario pasarela↔BD | **0**; cualquier valor >0 es incidente | **NUEVO** (OB-11) |
| S6 | Pedidos pagados cuya pasarela dice pagado pero el pedido está CANCELLED/REFUNDED | log `paid_but_inactive` / nº de llamadas a `alertPaidButInactiveOrder` | Log estructurado + canal operador | **0** | Parcial: se envía correo al cliente (OB-02); **NUEVO** el canal de plataforma |
| S7 | Tiempo pagado → email entregado | p95(`emailSentAt − paidAt`); y `% COMPLETED con emailSentAt` | BD `Order.emailSentAt` (**falta `paidAt`**); aproximar con cron `updatedAt` solo hasta tener `paidAt` | p95 ≤ 2 min; ≥ 99,5 % con email en ≤ 10 min | Parcial **HOY**: `% COMPLETED sin emailSentAt` (índice `[status,emailSentAt]`); **NUEVO** `paidAt` (migración aditiva). **Tienda: NUEVO** (sin campos de email) |
| S8 | Pedidos COMPLETED con email fallido/sin enviar | `count(Order COMPLETED, emailSentAt NULL, createdAt < now−10min)` | BD | 0 durante >15 min | **HOY** (SQL) |
| S9 | Emisión de QR/PDF | % de emails con adjunto PDF (`pdfBytes!=null`) | Log estructurado `email.sent {pdf:true}` | ≥ 99,9 % | **NUEVO** (hoy el fallo de PDF solo va a `console.error`) |
| S10 | Disponibilidad del sitio público por tenant | % de comprobaciones externas 2xx a `/`, `/eventos`, `/api/health` (200/503 `maintenance` cuenta como caída) | Monitor externo (UptimeRobot/Better Stack/Checkly) | ≥ 99,9 % 30 d (≈43 min); on-sale 99,95 % | **NUEVO** como histórico (hoy solo última comprobación en `TenantHealth`) |
| S11 | Disponibilidad de la ruta de compra | canario sintético: carga ficha de evento + `POST /api/orders` en modo test cada 5 min y tras cada deploy | Checkly/GitHub Actions o ruta propia | ≥ 99,9 % | **NUEVO** (§6) |
| S12 | Frescura del reconcile | `now − CronState.lastSuccessAt` de `reconcile-payments` y `errors` del último cuerpo | Panel (`CronState`) + cuerpo del cron (descartado hoy) | ≤ 10 min; `errors=0` 3 pasadas seguidas | Parcial **HOY** (edad); `errors` **NUEVO** (OB-01/06) |
| S13 | Tasa de rechazo de escaneo | `ScanLog.result != 'VALID'` / escaneos, desglosado: `PENDING_PAYMENT` (debe ser ≈0), `WRONG_EVENT`, `DUPLICATE`, `CANCELLED`, `INVALID` | BD `ScanLog` | `PENDING_PAYMENT` = 0; `INVALID`+`CANCELLED` < 1 % (muy por encima = QR/pago roto) | **HOY** salvo `INVALID` (no se registra, OB-20) |
| S14 | Concordancia contable | por día y tenant: Σ pedidos `COMPLETED` online (BD) = Σ cobros pasarela netos de reembolsos; Σ `TAQUILLA`/`CASH`+`CARD` (BD) vs cierre de caja (`Ingreso`) | BD (`channel`, `paymentMethod`) + API pasarela (nuevo) + `Ingreso` | diferencia 0,00 € (tolerancia 0,01) | Parcial **HOY** (sumas en BD); lado pasarela **NUEVO** (OB-11) |
| S15 | Cola de sala de espera | `max(now − joinedAt)` de `WAITING`; ratio `EXPIRED/ADMITTED` | BD `WaitingRoomEntry` | espera máx. ≤ 20 min; expirados ≤ 40 % | **HOY** (SQL) / **NUEVO** exponer |
| S16 | Rendimiento percibido (LCP, CLS, INP) en páginas de compra | p75 de CWV de `/eventos/[slug]`, `/comprar`, `/tienda` | Speed Insights Plus o `web-vitals` propio | LCP ≤ 2,5 s, CLS ≤ 0,1, INP ≤ 200 ms (p75, móvil) | **NUEVO** (OB-18) |
| S17 | Éxito del webhook | respuestas 2xx / (2xx+4xx+5xx) de `/api/webhooks/*` por tenant; y nº de `webhook.order_not_found` | Vercel (route+status) + log estructurado | ≥ 99,9 %; `order_not_found` = 0 | Parcial **HOY** (Vercel); `order_not_found` **NUEVO** (OB-03) |
| S18 | Salud de credenciales | `gatewayCredOk`, `smtpOk` desde el health profundo | health autenticado | 100 % del tiempo; alerta a la 2ª comprobación fallida | **NUEVO** (OB-06) |

**Presupuesto de error (error budget).** Para S10/S11 con 99,9 %/30 d el presupuesto es ≈43 min por tenant. Política: (1) alerta de *burn* cuando se consume >2 % del presupuesto en 1 h o >5 % en 6 h; (2) al consumir el 50 %, **congelar despliegues** de ese tenant (y de la plataforma si el fallo es del front compartido) hasta cerrar la causa; (3) al agotar, post-mortem obligatorio antes de nuevas features. Para S5/S6/S8 (dinero y entrega) el presupuesto es **cero**: cualquier ocurrencia es incidente y se registra en `tasks/` o en el issue tracker con causa raíz.

---

## 5. Lista mínima de alertas y dashboards (por prioridad)

Canal por defecto: ntfy al móvil del operador (ya soportado por `ALERT_WEBHOOK_URL`) + correo para severidad media. "Quién actúa": el operador de la plataforma (usted) salvo indicación. Un runbook de una línea por alerta.

### Alertas

| P | Alerta | Umbral | Canal | Quién actúa | Runbook (1 línea) |
|---|---|---|---|---|---|
| 1 | **Pago cobrado sin pedido** (S5, `webhook.order_not_found`, `paid_but_inactive`, importe no cuadra) | ≥1 | ntfy crítico | operador | Localizar sesión en la pasarela, completar o reembolsar el pedido a mano y contactar al comprador. |
| 2 | **Error 5xx en `/api/orders`, `/api/shop/orders` o `/api/webhooks/*`** (S1/S17) | ≥3 en 5 min por tenant, o anomaly de Vercel/Sentry | ntfy crítico | operador | Abrir Sentry/Logs filtrando host; si es el release último, Instant Rollback; si es pasarela, comprobar status page y clave. |
| 3 | **Pedido PENDING con `paymentId` más viejo de 20 min** (S4) | >20 min (>30 = crítico) | ntfy | operador | Revisar `reconcile-payments` del tenant (credencial, pasarela caída); lanzar el cron a mano desde el panel. |
| 4 | **Reconcile con errores** (`errors>0` 3 pasadas o `stillPending` por ERROR) (S12/OB-01) | 3 seguidas | ntfy crítico | operador | Probar conexión de la pasarela en `/admin/configuracion`; si la clave caducó, pedirla al cliente. |
| 5 | **Email de entradas sin enviar** (S8) | >0 durante 15 min, o >5 % en 1 h | ntfy + correo al `admin_email` del cliente | operador → cliente | Revisar `smtp_*` del cliente y reenviar desde `/admin/ventas`; si el SMTP es suyo, pedirle credenciales nuevas. |
| 6 | **Credencial de pasarela o SMTP inválida** (S18) | 2 comprobaciones seguidas | ntfy crítico | operador | Confirmar con el cliente; no abrir venta hasta verde. |
| 7 | **Sitio caído / en mantenimiento por tenant** (S10, health `blocked`/`unreachable`) | 2 fallos externos seguidos (≈6-10 min) | ntfy crítico | operador | Mirar `/health` del panel: si es esquema, `migrate:tenants --only`; si BD, consola Neon. |
| 8 | **Cron del panel no corre / latido ausente** | sin latido 15 min | healthchecks.io → móvil | operador | Mirar Vercel > Cron Jobs; relanzar `/api/cron/dispatch?job=tenants` con `PANEL_CRON_SECRET`. |
| 9 | **Migración fallida / registro sin publicar / licencia** | inmediato (ya existe) + `registro sin republicar >36 h` y licencia a <7 días | ntfy | operador | `/health` del panel → ficha del cliente → `migrate resolve` o republicar. |
| 10 | **Canario post-deploy falla** (S11) | 1 fallo tras deploy | GitHub Actions + ntfy | quien desplegó | Instant Rollback y abrir incidente; no migrar más tenants. |
| 11 | **Errores de BD/pool** `P2024`, `P2028`, `P1001`, `P2022` | ≥3 en 5 min | ntfy | operador | Ver conexiones en Neon; reducir tráfico (sala de espera) o subir cómputo; si `P2022`, falta migración (OB-14). |
| 12 | **Latencia p95 de creación de pedido** (S3) | >4 s 10 min seguidos | correo | operador | Comprobar contención de lock (muchas compras al mismo evento) y cómputo de Neon. |
| 13 | **Sala de espera atascada** (S15) | espera máx >20 min o ADMITTED expirados >40 % | correo | operador | Subir `waitingRoomConcurrentSlots` o ventana de compra desde admin del evento. |
| 14 | **Coste**: spend de Vercel (imágenes/funciones), Blob, Neon | 80 % del presupuesto mensual | correo | operador | Desactivar optimización de imágenes (`IMAGES_UNOPTIMIZED=1`) o revisar Blob por prefijo. |
| 15 | **Rendimiento**: LCP p75 >2,5 s o CLS >0,1 en compra (S16) | 2 días seguidos | correo semanal | operador | Revisar peso de imagen/vídeo del último cambio del tenant. |
| 16 | **Aforo 80/95/100 %** (existente) | ya existe | correo cliente | cliente | — (añadir copia al canal del operador solo para eventos con venta activa). |
| 17 | **Conciliación diaria con diferencia** (S14) | diferencia ≠ 0 | correo diario | operador | Abrir informe por tenant; cuadrar reembolsos y ventas de taquilla. |

### Dashboards (mínimo)

1. **Panel `/health` ampliado ("¿puedo abrir venta hoy?")**: una fila por tenant con semáforo de S4, S8, S12, S18, versión/esquema, última migración y último canario. Es el único que hace falta mirar antes de un on-sale.
2. **Vercel Observability (Plus)**: función por ruta (`/api/orders`, `/api/shop/orders`, `/api/webhooks/*`, `/api/cron/*`): invocaciones, errores, p75, y filtro por host; más el panel de Usage/Spend.
3. **Dashboard de venta en vivo (solo on-sale)**: pedidos/min, ratio PENDING→COMPLETED, errores 5xx, p95 de pedido, cola de sala de espera, emails pendientes. Puede ser una página de admin que lea SQL o el Notebook de Vercel Query (Plus).

---

## 6. Traducción de "Harness" a lo disponible y coste honesto (2-15 clientes)

Harness no existe en el proyecto y **no se propone integrarlo** (sería la herramienta equivocada para este tamaño). Equivalencias:

| Lo que daría Harness | Equivalente real en este stack | Coste orientativo |
|---|---|---|
| SRM (SLOs, error budget) | Tabla S1-S18 + monitor externo para S10/S11 + `ops` en `/api/health` y alertas del panel; el error budget es una hoja de cálculo/vista del panel por tenant | 0 € (trabajo propio) |
| Chaos Engineering | Plan manual de §7 en el entorno de pruebas permanente (`m8-ensayo.md` §3 recomienda dejarlo) | 0 € |
| Feature Flags (FFM) | Ya existen los módulos/licencias por tenant en el registro firmado; para kill-switch de ventas: `online_sales_closed` (`lib/online-sales-closed.ts`) | 0 € |
| Pipelines / despliegue progresivo | GitHub Actions (CI actual) + Vercel promoción manual + `migrate:tenants --canary`; añadir workflow `deployment_status` con canario | 0 € (minutos de Actions) |
| Observabilidad/alertas | **Vercel Observability Plus** (usage: 1,20 $ por millón de eventos; alertas, monitores personalizados, 30 d de logs) — https://vercel.com/docs/observability/observability-plus ; **Log Drains** (Pro; 0,50 $/GB) — https://vercel.com/docs/drains ; **Sentry** (plan gratuito/Team; verificar precio vigente) con tag `tenant` | Vercel: unos pocos $/mes a este volumen; Sentry: 0-26 $/mes (verificar) |
| Canario externo | UptimeRobot / Better Stack / Checkly (planes gratuitos o ~10-30 $/mes; verificar límites) con 2-3 checks por tenant: `/api/health` (keyword `"ok"`), ficha de evento (keyword), tienda | 0-30 $/mes |
| Latido del panel | healthchecks.io (gratis) ya previsto (`HEARTBEAT_URL`) | 0 € |
| Alertas al móvil | ntfy (gratis) ya soportado | 0 € |
| Rendimiento de campo | Speed Insights Plus (10 $/proyecto/mes + 0,65 $/10 000 eventos) o beacon propio de `web-vitals` | 10 $/mes o 0 € |

Orden de compra/activación recomendado: (1) confirmar Observability Plus (probablemente ya activo por defecto) → (2) Sentry free + tag tenant → (3) UptimeRobot/Better Stack → (4) Log Drain solo si necesita >30 d de retención o analítica propia.

**Canario sintético por tenant tras cada despliegue (diseño mínimo).** Workflow de GitHub `deployment_status` (o `workflow_run` tras CI en `plataforma`) que, para cada host publicado (lista obtenida del panel con un endpoint de solo lectura protegido), ejecuta: (1) `GET /api/health` público = 200 `ok` y `version == sha` del deploy; (2) `GET /` y `GET /eventos/<slug-canario>` con keyword esperada; (3) con el health autenticado, `ops.gatewayCredOk` y `ops.smtpOk`; (4) en un evento "canario" con gateway **mock/test** de cada tenant, `POST /api/orders` → `GET /api/orders/{id}` → comprobar COMPLETED → comprobar `emailSentAt` (email a un buzón controlado) → limpieza. Cualquier fallo: ntfy y **no** promocionar/ejecutar `migrate:tenants` en más tenants. Esfuerzo M. Nota: el pedido canario debe excluirse de S2/S14 (`channel='CANARY'`).

---

## 7. Plan de caos / pruebas de resiliencia proporcionado (entorno de pruebas, a mano)

Se ejecuta en el entorno `platform-pruebas` con 2 tenants (A/B) y pasarela en modo test (el repo ya tiene `loadtest/` y `tests/tenant/` con dos BDs). Cada prueba: qué inyectar → qué debe pasar → qué señal debe saltar. Una por semana al principio; antes de cada primera venta de un cliente nuevo, las 1-5.

| # | Fallo a inyectar | Cómo (sin herramientas pesadas) | Resultado esperado hoy / tras arreglos | Señal que debe saltar |
|---|---|---|---|---|
| 1 | **Pasarela caída / clave inválida** | Poner una `stripe_secret_key` basura (o `sumup_api_key`) en tenant A; crear 3 pedidos con checkout simulado y dejar pasar 2 pasadas del cron | **Hoy:** crons "ok", pedidos PENDING (OB-01). **Objetivo:** reconcile devuelve `errors>0`, alerta S12/S18, ningún pedido se cancela | Alerta #4 y #6 |
| 2 | **Webhook duplicado / fuera de orden** | `stripe trigger checkout.session.completed` (stripe-cli) 3 veces seguidas, y `expired` antes de `completed` | Un solo COMPLETED, un solo email (`ProcessedWebhookEvent` + CAS); el caso "expired antes de completed" debe dar `paid_but_inactive` | `paid_but_inactive` (#1) |
| 3 | **Webhook con `orderId` inexistente** | Enviar evento firmado con `orderId` falso | **Hoy:** 200 y "procesado" (OB-03). **Objetivo:** 5xx/alerta, no marcado procesado | Alerta #1 |
| 4 | **SMTP caído o lento** | Apuntar `smtp_host` del tenant a un puerto cerrado y luego a un servidor que no responde (`nc -l` sin respuesta) | **Hoy:** email "sin enviar" sin aviso; webhook lento (OB-07). **Objetivo:** timeout ≤20 s, sweeper reintenta, alerta de email | Alerta #5 |
| 5 | **BD lenta / pool agotado** | `connection_limit=1` en el tenant de prueba y 100 compras con k6 `race.js`; o `pg_sleep` vía transacción abierta en `psql` que mantenga el advisory lock del evento | Errores acotados `P2024/P2028`, mensajes de usuario correctos, sin sobreventa (`teardown.js`) | Alerta #11, S1 |
| 6 | **Pico de sala de espera** | `checkout-flow.js` con 3 000 usuarios/min contra evento con cola activa; matar un `ADMITTED` a mitad | La cola avanza; `oldestWaiting` ≤ 20 min; sin doble admisión | Alerta #13 (S15) |
| 7 | **Despliegue con esquema atrasado** | Subir `FRONT_MIN_SCHEMA` sin migrar B; lanzar compras en B | B = 503 `maintenance`, A intacto; webhooks de B reciben 503 y Stripe reintenta; al migrar, recupera solo | Alertas #7 y #9; comprobar que los pagos en vuelo se confirman tras la migración |
| 8 | **Cron del panel detenido** | Deshabilitar cron en Vercel 20 min (o apuntar `HEARTBEAT_URL` a un check propio) | healthchecks.io avisa; al reactivar, el panel se pone al día sin duplicar | Alerta #8 |
| 9 | **Registro (Upstash) caído** | Token erróneo en preview del entorno de pruebas / bloquear host | Sirve "lo último bueno" hasta 6 h, log `sirviendo obsoleto`; sin tráfico nuevo desconocido | Convertir `[tenant-resolve] sirviendo obsoleto` en alerta Sentry/Vercel (`m4-runtime.md:92` ya lo pide) |
| 10 | **Función cortada a mitad del webhook** | `maxDuration` artificialmente bajo + email lento | Evento no marcado procesado, Stripe reintenta, no se duplican entradas ni emails (comprobar `emailSentAt`) | S7/S8 |
| 11 | **Pago tras expirar** (SumUp) | Crear pedido, esperar liberación (bajar `MAX_AGE_MS` en pruebas), pagar después | Debe generar alerta de conciliación diaria (hoy invisible, OB-11) | Alerta #17 / S5 |
| 12 | **Fallo de Blob / PDF** | Token Blob inválido; forzar excepción en `buildTicketsPdf` | Email sale sin PDF pero con enlace de impresión; se registra `email.sent {pdf:false}` | S9 |

Criterio de cierre: cada fila con la señal esperada **recibida en el móvil** y anotada con fecha en una tabla (como la de `m8-ensayo.md:116`).

---

## 8. Plan de acción propuesto (orden)

**Antes de abrir ventas a un cliente real (P0, ~1 semana):**
1. OB-01 (adaptadores `status:'ERROR'`, no cancelar ante error, loguear `error`) · OB-03 (no marcar procesado si `null`, log+alerta) · OB-05 (activar/verificar Observability Plus + alertas de error por ruta; Sentry con tag tenant).
2. OB-04 + OB-02 + OB-06 como un único paquete: sweeper de email (entradas y tienda con migración aditiva), bloque `ops` en el health autenticado, canal de alertas del operador independiente del SMTP del cliente, reutilizando el motor de alertas del panel.
3. Monitor externo (OB-15) + verificar con "Enviar alerta de prueba" que ntfy y el latido llegan (m9, sección G).

**Semana 1-2 (P1):** OB-07, OB-08, OB-09, OB-10 (cambios pequeños), `paidAt` + conciliación diaria (OB-11), auditoría de admin (OB-12), logger estructurado (OB-13), higiene de despliegue y canario (OB-14), prueba de carga real (OB-16).

**Roadmap (P2):** OB-17…OB-22, RUM de rendimiento, informe de costes por tenant, plan de caos periódico.

### Fuentes (documentación pública consultada)
- Retención de logs de runtime: https://vercel.com/docs/logs/runtime
- Drains (Pro/Enterprise, 0,50 $/GB): https://vercel.com/docs/drains
- Alertas (Pro con Observability Plus; error anomaly, usage anomaly, monitores personalizados): https://vercel.com/docs/alerts
- Observability Plus (1,20 $/millón de eventos; por defecto en Pro desde 2026-04-03): https://vercel.com/docs/observability/observability-plus
- Speed Insights (gratis limitado; Plus 10 $/proyecto/mes): https://vercel.com/docs/speed-insights/limits-and-pricing
- Cron Jobs (Pro: 1/min; sin reintentos; entrega best effort y posible duplicado; sin log si no llega): https://vercel.com/docs/cron-jobs/usage-and-pricing y https://vercel.com/docs/cron-jobs/manage-cron-jobs
- Precios de Sentry/UptimeRobot/Better Stack/Checkly: no consultados; orden de magnitud, **verificar antes de contratar**.
