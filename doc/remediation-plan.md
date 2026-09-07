# Plan de Remediación — La Grailla

Basado en [doc/audit-report.md](audit-report.md) (49 hallazgos: 3 críticos, 10 altos, 16 medios, 20 bajos).

## Cómo está pensado este plan

No he ordenado los hallazgos por severidad tal cual salieron del informe — los he reordenado por **coste de arreglarlo vs. daño que evita**, que es como se prioriza esto en producción real:

1. **Fase 0 no arregla ningún bug — instala la red de seguridad.** Sin CI, cada fix de las fases siguientes se despliega a ciegas. Es la inversión de más apalancamiento del plan entero y cuesta medio día.
2. **Fase 1 es la única fase realmente bloqueante.** Son los 6 hallazgos que el propio informe marca como "no lanzar sin esto" — todos con dinero real o acceso físico al evento de por medio. Dentro de la fase, van ordenados por radio de explosión: primero lo que puede regalar todo el inventario (PAY-03), luego lo que puede dejar a un comprador sin su dinero (PAY-01/02), luego seguridad (SEC-02/01/03).
3. **Fase 2 es "antes del primer evento con público real"**, no "antes de programar la primera venta". Cosas que importan cuando ya hay tráfico y dinero de verdad moviéndose pero que no impiden abrir la venta.
4. **Fase 3 es deuda de datos** — cambios más invasivos (migración de esquema) que merecen su propio ciclo de trabajo, no mezclarse con las urgencias de la Fase 1.
5. **Fase 4 es backlog** — mejora el código pero nada de esto va a doler si se pospone.

Cada hallazgo de Fase 1 y 2 que tiene un test en `__tests__/audit/` se trabaja así: **ejecutar el test (debe fallar) → arreglar → ejecutar de nuevo (debe pasar) → commit**. Es la forma más rápida de tener certeza de que el fix funciona sin tener que probarlo a mano en el navegador.

---

## Fase 0 — Red de seguridad (medio día, antes de tocar nada más)

| # | Tarea | Esfuerzo | Nota |
|---|---|---|---|
| 0.1 | **TEST-01**: `.github/workflows/ci.yml` — `npm ci && npx tsc --noEmit && npm run lint && npm test` en cada PR y push a `main`, con un servicio Postgres efímero (`postgres:16` como servicio de GitHub Actions, igual que `docker-compose.yml` local) | S | Bloquear merge a `main` si falla (branch protection) |
| 0.2 | Quitar `eslint: { ignoreDuringBuilds: true }` de `next.config.js` (PROD-03) ahora que el lint sí se ejecuta en CI | S | Revisar que no haya warnings acumulados que rompan el build al activarlo |
| 0.3 | Ejecutar `npm test` ya mismo en local/CI y confirmar que los 5 tests de `__tests__/audit/` están en rojo | S | Es la prueba de que el informe de auditoría describe bugs reales, no hipótesis |

**Criterio de salida:** un PR de prueba dispara el workflow, corre contra Postgres real, y los 5 tests de auditoría aparecen como fallo visible en la CI (no solo en local).

---

## Fase 1 — Bloqueantes de producción (los 6 del informe)

Esto es lo único que de verdad impide abrir venta real. Orden por radio de explosión, no por como aparecen en el informe.

| Orden | Hallazgo | Qué se hace | Esfuerzo | Test |
|---|---|---|---|---|
| 1 | **PAY-03** | Guard en `getPaymentProvider()`: si `NODE_ENV === 'production'` y `payment_gateway === 'mock'` (o sin configurar), bloquear el checkout con un error explícito en vez de completarlo gratis | S (1-2h) | Escribir uno nuevo, no existe en `__tests__/audit/` |
| 2 | **PAY-01** | En `invalidateOrder`, si `mode === 'CANCELLED'` y `order.status === 'COMPLETED'` con `paymentMethod === 'CARD'` y proveedor real (no mock): exigir el mismo flujo de reembolso que `REFUNDED`, o rechazar la acción y forzar "reembolsar" desde la UI | M (medio día) | `payments-cancel-completed-card-no-refund.test.ts` |
| 3 | **PAY-02** | Crear `invalidateShopOrder` (análogo a `invalidateOrder`: reembolso vía `getPaymentProviderByName` + `releaseShopStock`) y usarlo desde `PUT /api/admin/shop-orders/[id]` en vez del update plano | M (1 día) | `payments-shop-order-refund-no-stock-release.test.ts` |
| 4 | **SEC-02** | `signShopOrderAccess`/`verifyShopOrderAccess` en `lib/access-token.ts` (mismo patrón que `signOrderAccess`), propagar `?t=` en la redirección de `tienda/checkout` y exigirlo en el `GET` | M (medio día) | `security-shop-order-idor.test.ts` |
| 5 | **SEC-01** | Reutilizar `esc()` de `lib/tickets.ts` (extraerlo a un helper compartido, p.ej. `lib/html-escape.ts`) en `pdf-html/route.ts`; añadir `.max(100)` a `buyerName`/`buyerLastName`/`guestName` en los Zod de `orders`, `invitations`, `taquilla/sale` | S (1-2h) | `security-xss-pdf-html.test.ts` |
| 6 | **SEC-03** | Sustituir el `update` de `scan/route.ts` por `updateMany({ where: { id, status: 'VALID' }, ... })`; solo incrementar aforo/registrar `scanLog: 'VALID'` si `count === 1`, si no `DUPLICATE` | S (1-2h) | `security-scan-race-condition.test.ts` |

**Criterio de salida:** los 6 tests (5 existentes + el nuevo de PAY-03) están en verde en CI. Antes de mergear cada uno, confirmar a mano en `/admin/pedidos` y `/acceso` que el flujo real (botón "Cancelar", pantalla de escaneo) se comporta como se espera — los tests cubren la lógica de servidor, no la UI.

**Recomendación de ejecución:** 6 PRs separados, no uno solo. Son cambios en dinero y control de acceso — si algo sale mal, quieres poder revertir un PR de 30 líneas, no un PR de 6 fixes mezclados.

---

## Fase 2 — Antes del primer evento con público real

No bloquean abrir la venta, pero sí quieres tenerlos antes de que haya cientos de personas en la puerta con el móvil en la mano.

| Hallazgo | Qué se hace | Esfuerzo |
|---|---|---|
| **TEST-02** | `@sentry/nextjs` — captura de errores + alertas (mínimo: email/Slack en error 500 de una API route) | M (medio día setup + verificar que captura en producción) |
| **SEC-04** | Ampliar el matcher de `middleware.ts` a `/api/admin/:path*`, `/api/taquilla/:path*`, `/api/scan`, `/api/access/:path*` devolviendo 401 JSON si no hay sesión — red de seguridad para futuros endpoints, no sustituye los checks inline | S |
| **SEC-05** | `crypto.timingSafeEqual` en la comparación de `CRON_SECRET` (`reconcile-payments`, `cleanup-waiting-room`) — mismo patrón que `lib/access-token.ts` | S |
| **PROD-01** | Guard en `safe-seed.ts`: abortar si `DATABASE_URL` no contiene `localhost`/`127.0.0.1` salvo `ALLOW_PROD_SEED=1` explícito | S |
| **DATA-03** | Pre-chequeo en `DELETE /api/admin/events/[id]` (¿tiene `Order`/`Ticket`?) igual que ya existe en `ticket-types/[id]`, o mapear `P2003` a 409 en `lib/api-error.ts` | S |
| **PAY-04** | Cerrar el TOCTOU de `invalidateOrder`: mover el chequeo de estado a una escritura condicional (`updateMany` con `where: { status: {in: [...]} }`) antes de proceder al reembolso | M |
| **PAY-05** | Documentar (o mover) el orden de dedup del webhook de Stripe — decidir si se acepta la dependencia del cron de 5 min o se mueve el insert de `ProcessedWebhookEvent` a después del éxito | S (decisión) + S (implementación) |
| **PAY-06** | Pasar `order.id`/`shopOrder.id` como `idempotencyKey` a `stripe.checkout.sessions.create`/`refunds.create` | S |
| **TEST-05** | Test que fuerza un `fetch` fallido/timeout de Stripe/SumUp durante la creación de pedido (no solo en el cron) | S |
| **PERF-03** | Comprobar `notAfter` del certificado Apple Wallet antes de firmar; alertar por email si expira en <30 días (reusar el patrón de `alertPaidButInactiveOrder`) | S |

**Criterio de salida:** Sentry recibiendo eventos reales de un error provocado a propósito en staging; el resto son fixes puntuales verificables con test o revisión manual rápida.

---

## Fase 3 — Deuda de integridad de datos (ciclo propio, no mezclar con Fase 1/2)

| Hallazgo | Qué se hace | Esfuerzo |
|---|---|---|
| **DATA-01** | Migrar `Float → Decimal(10,2)` en los 14 campos monetarios (`TicketType.price`, `Order.totalAmount`/`commission`, `Product.price`, `ShopOrder.totalAmount`, `ShopOrderItem.unitPrice`, y los 8 campos de `Articulo`/`PrecioArticulo`/`LineaPedido`/`Gasto`). Actualizar toda la aritmética a `Prisma.Decimal` en `lib/pricing.ts`, `lib/order-reconciliation.ts`, `lib/product-stock.ts`, `lib/compras/*` | L (varios días: migración de esquema + código + revisión de cada cálculo + probar contra los datos ya cargados de Temporada 2025/2026) |
| **DATA-02** | `@@index([ticketTypeId])` en `Ticket` | S |
| **DATA-06** | `@@index([productId])` en `ShopOrderItem` | S |
| **DATA-04** | Añadir `temporadaId String?` opcional a `Product`, `ShopOrder`, `SponsorRequest` (mismo patrón que `Event.temporadaId`, sin backfill) — solo si el negocio realmente quiere reportes por edición separados para tienda/sponsors | M |

**Nota:** DATA-01 es invasivo pero no urgente — mover primero, con calma, cuando no haya una venta activa en curso (una migración de tipo de columna con la tabla `Order` en uso concurrente es exactamente el tipo de cambio que quieres hacer en una ventana tranquila, no la noche antes de un evento). Si hay margen de tiempo antes del primer evento en vivo, adelantarlo tiene sentido; si no, puede esperar a después sin riesgo real a corto plazo (el error de redondeo es de céntimos, no de euros).

---

## Fase 4 — Backlog (sin urgencia, mejora mantenibilidad/rendimiento)

Agrupados porque ninguno duele si se pospone; picar de aquí cuando haya un hueco entre features.

**Seguridad defensa-en-profundidad:** SEC-06 (magic bytes en uploads), SEC-07 (sanitizar SVG), SEC-08 (sanitizar nombre de archivo), SEC-09 (rate-limit en `extraer-imagen`), SEC-10 (validar formato al guardar config), SEC-11 (rol en `change-password`, sin impacto real).

**Arquitectura:** ARCH-02 (extraer suma de subtotal de taquilla a `lib/pricing.ts`), ARCH-03 (HSTS explícito), ARCH-04 (logging estructurado), ARCH-05 (try/catch en `wallet/status`), ARCH-06 (adapter para verificación de webhook), ARCH-07 (SWR/React Query en admin — el más grande de este grupo, es un cambio de patrón transversal, no un fix puntual). ARCH-01 (CSP `unsafe-inline`) se queda documentado como limitación conocida de Next 14 App Router, no accionable sin rediseñar el rendering — revisar si Next 15 lo resuelve al migrar en el futuro.

**Rendimiento:** PERF-01 (paginar `admin/shop-orders`), PERF-02 (timeout en llamadas IA), PERF-04 (`next/image` en páginas públicas), PERF-05 (`next/dynamic` para `recharts`), PERF-06/INT-02 (quitar `maplibre-gl`), PERF-07 (paginar `admin/users`), PERF-08 (thresholds en `race.js`).

**Testing:** TEST-04 (BD de test dedicada en CI — se vuelve más importante cuanto más crezca el equipo), TEST-06 (test combinado webhook+cron), TEST-07 (thresholds k6).

**Integraciones:** INT-01 (reintento de email vía el cron existente).

**Go-live:** PROD-02 (documentar `NEXT_DIST_DIR`/`NEXT_OUTPUT_MODE` en `.env.example`).

---

## Resumen ejecutivo

| Fase | Qué protege | Esfuerzo total aprox. | Cuándo |
|---|---|---|---|
| 0 | Que un fix futuro no rompa algo sin que nadie se entere | 0,5 día | Ya, antes de la Fase 1 |
| 1 | Dinero de clientes + acceso físico al evento | 2-3 días | Antes de abrir venta real |
| 2 | Visibilidad operativa + robustez ante concurrencia real | 2-3 días | Antes del primer evento con público |
| 3 | Precisión contable a largo plazo | Varios días (ventana tranquila) | Antes de acumular 2-3 temporadas más de histórico |
| 4 | Mantenibilidad y rendimiento | Continuo, sin fecha | Entre features |

**Total hasta poder abrir venta real con confianza: Fases 0+1, ~3-4 días de trabajo.**

Dime si quieres que empecemos ya por la Fase 0 (el workflow de CI) o directamente por el primer punto de la Fase 1 (el guard de PAY-03, que es el más barato y el de mayor radio de explosión si algo sale mal).
