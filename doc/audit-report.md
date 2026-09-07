# Informe de Auditoría Técnica — La Grailla

**Fecha:** 2026-09-04
**Alcance:** análisis estático completo del repositorio (80 rutas de API, 32 páginas, `prisma/schema.prisma` de 737 líneas, 16 migraciones, `tests/`, `loadtest/`, `.github/workflows/`).
**Metodología:** lectura exhaustiva de código fuente por 7 agentes especializados en paralelo + verificación cruzada directa de los hallazgos más críticos sobre el código real.

**⚠️ Limitación de cobertura — pruebas dinámicas no ejecutadas.** El entorno desde el que se ha realizado esta auditoría no tiene Node.js/npm accesible, por lo que no se ha podido arrancar el servidor de desarrollo (`localhost:57810`) ni ejecutar la suite de Vitest, ni hacer peticiones HTTP reales, ni navegar la UI. **Todo lo que sigue es análisis estático de código**, no verificación en caliente. Los 5 tests de regresión generados en `__tests__/audit/` (ver Fase 5, sección final) tampoco se han podido ejecutar — hay que correrlos manualmente (`npm test`) para confirmar que reproducen el bug antes de corregirlo, y que pasan después.

## Resumen de severidades

| Severidad | Cantidad |
|-----------|----------|
| 🔴 Crítico | 3 |
| 🟠 Alto | 10 |
| 🟡 Medio | 16 |
| 🔵 Bajo | 20 |

---

## 1. Seguridad

### Resumen del estado actual
La autorización por rol está implementada de forma consistente y verificada manualmente en ~50 endpoints de `/api/admin/**`, `/api/taquilla/**`, `/api/scan` y `/api/access/**` — todos comprueban `getServerSession` + rol antes de tocar datos, incluso donde `middleware.ts` no los protege (su matcher solo cubre `/admin/:path*` y `/acceso/:path*`, páginas, no `/api/**`). El sistema de tokens de acceso público sin sesión (`lib/access-token.ts`, HMAC-SHA256 vía HKDF de `NEXTAUTH_SECRET`, comparación `timingSafeEqual`) está bien diseñado y se usa correctamente en pedidos de entradas, tickets/wallet y portal de sponsors. El cifrado de secretos en reposo (AES-256-GCM, IV aleatorio, authTag verificado) es correcto. Sin embargo, se han encontrado **tres hallazgos críticos/altos** que rompen ese patrón en puntos concretos.

### Hallazgos

**[🔴 CRÍTICO] SEC-01 — XSS almacenado en impresión de entradas (`pdf-html`)**
- **Archivo:** [app/api/tickets/[orderId]/pdf-html/route.ts:46,49,53,56-58](app/api/tickets/[orderId]/pdf-html/route.ts)
- **Evidencia:** `order.event?.name`, `ticket?.holderName`, `ticket?.ticketType?.name` se interpolan directamente en el HTML de respuesta (`Content-Type: text/html`) sin escapar — a diferencia de la función equivalente para email (`lib/tickets.ts`), que sí usa un helper `esc()`. `holderName` proviene de `buyerName`/`buyerLastName`, texto libre del checkout público sin límite de longitud ni filtrado.
- **Impacto:** un comprador puede fijar su nombre a `<img src=x onerror=...>`. El HTML se abre sin sandboxing desde el panel de taquilla (`app/acceso/_components/taquilla-panel.tsx:132,159`, `window.open`/`<a target="_blank">`) con la sesión de staff activa — robo de cookie de sesión de NextAuth, acciones administrativas suplantando al taquillero.
- **Recomendación:** reutilizar `esc()` de `lib/tickets.ts` (o extraer la plantilla a una función compartida) y escapar todos los campos derivados de datos de usuario. Limitar longitud de `buyerName`/`buyerLastName`/`guestName` en los esquemas Zod de `orders`, `invitations`, `taquilla/sale`.
- **Test generado:** [__tests__/audit/security-xss-pdf-html.test.ts](__tests__/audit/security-xss-pdf-html.test.ts)

**[🔴 CRÍTICO] SEC-02 — IDOR sin ningún control de acceso en `GET /api/shop/orders/[orderId]`**
- **Archivo:** [app/api/shop/orders/[orderId]/route.ts:9-52](app/api/shop/orders/[orderId]/route.ts)
- **Evidencia:** no llama a `getServerSession` ni a ningún token de `lib/access-token.ts`, a diferencia de sus cuatro equivalentes (`orders/[orderId]`, `tickets/[orderId]/pdf-html`, `wallet/apple|google/[ticketId]`, `patrocinadores/[sponsorId]/*`), que sí exigen token firmado o sesión de staff. El frontend de tienda tampoco genera ni envía ningún token.
- **Impacto:** cualquiera que conozca/enumere un `orderId` de tienda obtiene nombre completo, email, dirección postal completa y teléfono del comprador. Sin rate limiting adicional en este endpoint.
- **Recomendación:** replicar el patrón de `signOrderAccess`/`allowOrderAccess` para `ShopOrder` (p.ej. `signShopOrderAccess`), propagar el token en la URL de confirmación de tienda, y exigirlo (o sesión ADMIN) en el `GET`.
- **Test generado:** [__tests__/audit/security-shop-order-idor.test.ts](__tests__/audit/security-shop-order-idor.test.ts)

**[🟠 ALTO] SEC-03 — Condición de carrera (TOCTOU) en el escaneo de QR permite doble entrada**
- **Archivo:** [app/api/scan/route.ts:105-140](app/api/scan/route.ts)
- **Evidencia:** el ticket se lee una vez (`findUnique`) y su `status` se evalúa fuera de la transacción de escritura; el `update` que marca `USED` filtra solo por `id`, no por `status: 'VALID'`. Dos escaneos casi simultáneos del mismo QR pueden ambos superar el chequeo de "ya usado" antes de que ninguno confirme su escritura.
- **Impacto:** doble entrada admitida a un evento con QR compartido/reenviado, y `Event.currentCount` incrementado dos veces (desincroniza el aforo en tiempo real).
- **Recomendación:** sustituir el `update` incondicional por un `updateMany({ where: { id, status: 'VALID' }, data: {...} })` y solo continuar (incrementar aforo, registrar `scanLog` como `VALID`) si `count === 1`.
- **Test generado:** [__tests__/audit/security-scan-race-condition.test.ts](__tests__/audit/security-scan-race-condition.test.ts)

**[🟡 MEDIO] SEC-04 — `middleware.ts` no cubre `/api/admin/**` como red de seguridad**
- **Archivo:** [middleware.ts:34-36](middleware.ts)
- El matcher solo protege `/admin/:path*` y `/acceso/:path*` (páginas). Hoy no hay ninguna ruta admin realmente desprotegida (todas comprueban rol inline), pero no hay ninguna defensa en profundidad si un futuro endpoint olvida el check — el hallazgo SEC-02 ilustra justo ese patrón de riesgo en un módulo distinto. **Recomendación:** ampliar el matcher a `/api/admin/:path*` (y opcionalmente `/api/taquilla/:path*`, `/api/scan`, `/api/access/:path*`) devolviendo 401 JSON.

**[🟡 MEDIO] SEC-05 — Comparación de `CRON_SECRET` no es timing-safe**
- **Archivo:** [app/api/cron/reconcile-payments/route.ts:37](app/api/cron/reconcile-payments/route.ts), mismo patrón en `cleanup-waiting-room/route.ts`
- Usa `!==` en vez de `crypto.timingSafeEqual`, inconsistente con el propio estándar interno (`lib/access-token.ts`). Riesgo práctico bajo (requiere muchísimas peticiones), pero trivial de corregir.

**[🟡 MEDIO] SEC-06 — Subida de archivos valida solo `Content-Type` declarado, no magic bytes**
- **Archivos:** [app/api/admin/upload/route.ts:24](app/api/admin/upload/route.ts), [app/api/patrocinadores/[sponsorId]/logo/route.ts:53](app/api/patrocinadores/[sponsorId]/logo/route.ts)
- `file.type` refleja lo que declara el cliente, no el contenido real. El endpoint de logo de sponsor es **público** (solo token de sponsor, sin cuenta) — mayor superficie de riesgo que el de admin. **Recomendación:** validar magic bytes reales (p.ej. librería `file-type`) antes de subir a Blob Storage.

**[🟡 MEDIO] SEC-07 — SVG de logos de sponsor sin sanitizar**
- **Archivo:** [app/api/patrocinadores/[sponsorId]/logo/route.ts:13-19](app/api/patrocinadores/[sponsorId]/logo/route.ts)
- Se acepta `image/svg+xml` hasta 10MB sin despojar `<script>`/`on*=`. El riesgo principal está mitigado porque se renderiza vía `<img>` (los navegadores no ejecutan script embebido en ese contexto), pero si alguien abre la URL del blob directamente como documento, sí se ejecuta. **Recomendación:** sanear con DOMPurify (modo SVG) o excluir el tipo.

**[🔵 BAJO] SEC-08 — Nombre de archivo no sanitizado en la key de Blob Storage** ([app/api/admin/upload/route.ts:31](app/api/admin/upload/route.ts)) — mitigado por el prefijo `crypto.randomUUID()`, pero `file.name` no se normaliza. Sanitizar como defensa en profundidad.

**[🔵 BAJO] SEC-09 — `extraer-imagen` (IA) sin rate-limit propio** ([app/api/admin/compras/articulos/extraer-imagen/route.ts](app/api/admin/compras/articulos/extraer-imagen/route.ts)) — a diferencia de `sponsors-portal/generate`, que sí limita a 3 intentos. Gateado por ADMIN, riesgo de coste no acotado bajo, pero recomendable añadir `rateLimit()`.

**[🔵 BAJO] SEC-10 — Config de Stripe/SMTP/Wallet se guarda sin validar formato** ([app/api/admin/config/route.ts:11-22](app/api/admin/config/route.ts)) — Zod solo exige `key` no vacío; `value` es texto libre sin formato exigido. Un dato mal formado solo se descubre al fallar en un checkout/envío real.

**[🔵 BAJO] SEC-11 — `change-password` no restringe por rol** ([app/api/admin/change-password/route.ts:16-20](app/api/admin/change-password/route.ts)) — solo exige sesión válida, no rol. Sin impacto real porque opera exclusivamente sobre `session.user.id` (autoservicio, exige contraseña actual).

**Verificaciones sin hallazgos (confirmadas correctas):** cifrado AES-256-GCM de secretos (IV aleatorio, authTag verificado, clave derivada por HKDF); rate limiting de login (5/email, 20/IP por 15 min, respaldado en Postgres, sobrevive a cold starts serverless); QR con UUIDv4 (no predecible) + `@unique`; firma criptográfica real del `.pkpass` (no falsificable sin el certificado privado); wallets requieren token firmado, no basta con el `ticketId`; sin certificados commiteados en el repo; `hashedPassword` correctamente excluido con `select` en los endpoints de listado de usuarios; `/api/signup` deshabilitado (siempre 404); protección explícita contra quitar el rol al último admin o autoeliminarse.

### Preguntas abiertas
- ¿Hay algún WAF/CSP a nivel de Vercel/edge que mitigue parcialmente SEC-01? No visible desde el código del repo.
- No se ha podido verificar en caliente el comportamiento de concurrencia real de SEC-03 en Vercel serverless (nivel de aislamiento de Postgres bajo carga real) — el hallazgo es válido a nivel de lógica de aplicación independientemente de la infraestructura.

---

## 2. Integridad de Datos y Base de Datos

### Resumen del estado actual
El schema (737 líneas, 16 migraciones limpias y aditivas) tiene buena cobertura de `@unique`/`@@index` en los campos de búsqueda más críticos (email, slug, qrCode) y políticas `onDelete` mayormente coherentes. El hallazgo sistémico más relevante es el uso de `Float` para **todo** el dinero del sistema, sin una sola excepción.

### Hallazgos

**[🟠 ALTO] DATA-01 — Todos los importes monetarios son `Float`, no `Decimal`**
- **Archivo:** `prisma/schema.prisma` — 14 campos afectados en `TicketType.price`, `Order.totalAmount`/`commission`, `Product.price`, `ShopOrder.totalAmount`, `ShopOrderItem.unitPrice`, `Articulo.ivaPercent`, `PrecioArticulo.precioSinIva`/`descuentoPercent`, `LineaPedido.precioSinIva`/`descuentoPercent`/`ivaPercent`, `Gasto.importeSinIva`/`ivaPercent`.
- **Impacto:** errores de redondeo binario acumulativos en sumas/multiplicaciones de dinero — descuadres contables reales, especialmente en `Gasto`/`LineaPedido` (contabilidad de la caseta) y `Order.totalAmount` (dinero cobrado con Stripe/SumUp). `lib/pricing.ts:6-8` calcula comisión en `Float`.
- **Recomendación:** migrar todos estos campos a `Decimal @db.Decimal(10,2)` y actualizar el código de aritmética (`lib/order-reconciliation.ts`, `lib/product-stock.ts`, cálculos de IVA) para usar `Prisma.Decimal`.

**[🟡 MEDIO] DATA-02 — Falta índice en `Ticket.ticketTypeId`**
- Se consulta con `prisma.ticket.count({ where: { ticketTypeId } })` sin otro filtro en [app/api/admin/ticket-types/[id]/route.ts:63](app/api/admin/ticket-types/[id]/route.ts) — table scan completo con volumen creciente de entradas.

**[🟡 MEDIO] DATA-03 — `DELETE /api/admin/events/[id]` no maneja la violación de FK al borrar un evento con ventas**
- `Order.event`/`Ticket.event` no declaran `onDelete` (Prisma aplica `Restrict` por defecto), pero el endpoint llama a `prisma.event.delete()` directamente sin pre-chequeo — a diferencia de `ticket-types/[id]`, que sí comprueba antes de borrar. El error P2003 cae en el catch genérico → 500 sin mensaje de negocio. **Recomendación:** pre-check igual que en `ticket-types`, o mapear P2003 a un 409 con mensaje claro en `lib/api-error.ts`.

**[🟡 MEDIO] DATA-04 — `Product`/`ShopOrder`/`Sponsor` no están vinculados a `Temporada`**
- Solo `Event.temporadaId` existe. Al crecer el histórico multi-edición, no hay forma de filtrar/archivar ventas de merch o patrocinios por edición sin inferir por fecha. **Recomendación:** si el negocio opera por ediciones reales, añadir `temporadaId String?` opcional (mismo patrón que `Event`) a estos modelos.

**[🔵 BAJO] DATA-05** — indicio de drift manual en la migración `20260825183000_product_variants_and_email_attempts` (usa `ADD COLUMN IF NOT EXISTS`, que Prisma no genera por sí solo) — confirmar con el equipo que el esquema de `Order` en producción coincide exactamente con el actual.

**[🔵 BAJO] DATA-06** — `ShopOrderItem.productId` sin índice explícito (FK sin índice, sin uso directo detectado hoy, recomendable por higiene).

### Verificaciones sin hallazgos
`Ticket.qrCode` con `@unique` (sin riesgo de colisión); enums de estado sin valores "muertos" ni transiciones sin cubrir (`releaseExpiredOrder` cubre el caso de pedidos `PENDING` indefinidos); `hashedPassword` correctamente excluido en endpoints de usuarios.

### Preguntas abiertas
- Confirmar con el equipo si el drift de DATA-05 es intencional (¿se aplicó algo manualmente en Neon en algún momento?).
- ¿Hay estrategia de backups automatizados en Neon (point-in-time recovery)? No verificable desde el código — confirmar en el dashboard de Neon antes de producción.

---

## 3. Pagos y Lógica de Negocio Crítica

### Resumen del estado actual
El diseño de idempotencia, transacciones y protección de aforo/stock es sólido: creación de pedido + reserva de aforo ocurre siempre dentro de `$transaction`, con `pg_advisory_xact_lock` por evento para serializar taquilla y venta online entre sí, y `updateMany` condicionales atómicos para stock de tienda. El precio nunca se acepta del cliente — siempre se recalcula server-side desde la BD. El webhook de Stripe verifica firma y es idempotente vía `ProcessedWebhookEvent`. Sin embargo, se han encontrado **fallos críticos/altos en el flujo de reembolso**, la pieza más sensible del ciclo de vida del dinero.

### Hallazgos

**[🔴 CRÍTICO] PAY-01 — "Cancelar" un pedido de entradas ya `COMPLETED` (pagado con tarjeta) no reembolsa el dinero**
- **Archivo:** [lib/order-reconciliation.ts:124-188](lib/order-reconciliation.ts), función `invalidateOrder`
- **Evidencia:** la única restricción de estado-origen y la única llamada a la pasarela (`provider.refund`) están dentro del bloque `if (mode === 'REFUNDED')`. Para `mode === 'CANCELLED'` no hay ningún chequeo de `order.status` ni llamada al gateway. [app/api/admin/orders/[id]/route.ts:11-13,56](app/api/admin/orders/[id]/route.ts) expone `action: 'cancel'` sin ninguna validación adicional.
- **Impacto:** un admin puede pulsar "Cancelar" en vez de "Reembolsar" sobre un pedido ya cobrado: las entradas se anulan, el aforo se libera y vuelve a venta — pero el comprador **nunca recibe el reembolso**.
- **Recomendación:** en `invalidateOrder`, si `mode === 'CANCELLED'` y `order.status === 'COMPLETED'` con pago con tarjeta, exigir el mismo flujo de reembolso que `REFUNDED`, o bloquear la acción "cancelar" sobre pedidos `COMPLETED` forzando "reembolsar". Confirmar también si la UI del admin distingue visualmente ambas acciones.
- **Test generado:** [__tests__/audit/payments-cancel-completed-card-no-refund.test.ts](__tests__/audit/payments-cancel-completed-card-no-refund.test.ts)

**[🟠 ALTO] PAY-02 — `ShopOrder` no tiene ninguna lógica de reembolso ni liberación de stock**
- **Archivo:** [app/api/admin/shop-orders/[id]/route.ts:10-38](app/api/admin/shop-orders/[id]/route.ts)
- **Evidencia:** el `PUT` es un `prisma.shopOrder.update({ data: { status: body.status, ... } })` plano — no importa `getPaymentProviderByName` ni `releaseShopStock`. No existe ningún equivalente de `invalidateOrder` para pedidos de tienda.
- **Impacto:** marcar un pedido de tienda como `REFUNDED`/`CANCELLED` no devuelve el dinero cobrado ni libera el stock reservado en `ProductVariant` — el inventario queda "vendido" indefinidamente.
- **Recomendación:** crear `invalidateShopOrder` análogo a `invalidateOrder` (reembolso vía adapter + `releaseShopStock`) y usarlo desde el PUT.
- **Test generado:** [__tests__/audit/payments-shop-order-refund-no-stock-release.test.ts](__tests__/audit/payments-shop-order-refund-no-stock-release.test.ts) (cubre la parte de liberación de stock, verificable sin mockear el gateway)

**[🟠 ALTO] PAY-03 — Pasarela "mock" por defecto puede completar ventas reales sin cobrar**
- **Archivos:** [lib/payment-adapter.ts:305-314](lib/payment-adapter.ts), [lib/config.ts:5](lib/config.ts)
- **Evidencia:** `payment_gateway` tiene default `'mock'` si nadie ha configurado `/admin/configuracion`. Con `mock`, el checkout completa el pedido (`COMPLETED`, entradas `VALID`) instantáneamente sin cobrar nada — comportamiento intencional para desarrollo, pero sin ningún guard para producción.
- **Impacto:** si se despliega a producción y se anuncia venta de entradas antes de configurar Stripe/SumUp, se regalarían entradas/productos indefinidamente sin ningún aviso.
- **Recomendación:** añadir un guard (p.ej. `NODE_ENV=production` + `payment_gateway==='mock'` → bloquear checkout o loguear alerta crítica visible).

**[🟡 MEDIO] PAY-04 — Race condition (TOCTOU) en `invalidateOrder`**
- Dos llamadas concurrentes de reembolso sobre el mismo pedido podrían ambas pasar el chequeo de estado antes de que ninguna escriba (lectura de estado fuera de una transacción atómica condicionada). Menor prioridad que PAY-01/02 pero mismo patrón de riesgo.

**[🟡 MEDIO] PAY-05 — Deduplicación del webhook de Stripe se marca *antes* de procesar el evento**
- [app/api/webhooks/stripe/route.ts:47-56](app/api/webhooks/stripe/route.ts) inserta en `ProcessedWebhookEvent` antes de ejecutar `resolvePaidCheckout`. Si el procesamiento falla a mitad, el reintento de Stripe choca con el `P2002` sin reprocesar — la recuperación depende entonces del cron de reconciliación (cada 5 min), no del propio reintento del webhook. Mitigado por el cron, pero vale la pena documentar esa dependencia o mover el insert de dedup a después del éxito.

**[🟡 MEDIO] PAY-06 — Sin `idempotencyKey` nativo de Stripe en `checkout.sessions.create`/`refunds.create`**
- [lib/payment-adapter.ts:88-103,132-135](lib/payment-adapter.ts) — el riesgo real ya está cubierto por la clave única de Postgres a nivel de pedido, pero pasar `order.id` como `idempotencyKey` a Stripe añade una capa extra de defensa.

**[🔵 BAJO] PAY-07** — `SumUpAdapter` sin timeout/`AbortController` explícito en sus `fetch` — depende solo del límite de la plataforma.
**[🔵 BAJO] PAY-08** — productos sin ninguna `ProductVariant` (solo posible vía inserción fuera del panel admin) no tienen tope de stock — mitigado porque el endpoint de creación de productos siempre crea al menos una variante.

### Verificaciones sin hallazgos
Ningún vector de manipulación de precio desde el cliente; aforo/stock protegido consistentemente entre taquilla y venta online (mismo advisory lock, mismo criterio); transacciones de compensación correctas si falla la creación de la sesión de pago tras crear el pedido; webhook de Stripe verifica firma correctamente.

### Preguntas abiertas
- ¿La UI del admin distingue visualmente "Cancelar" de "Reembolsar" para pedidos ya pagados, o ambos botones se ven equivalentes? (componente no auditado en detalle).
- ¿Hay monitorización de que el workflow de GitHub Actions de reconciliación siga ejecutándose (fallo silencioso = única red de seguridad para pagos SumUp pendientes)?
- ¿Es intencional que `payment_gateway` por defecto sea `mock` hasta que un admin lo cambie explícitamente, o se espera un paso de despliegue que lo fije?

---

## 4. Arquitectura y Calidad de Código

### Resumen del estado actual
Este es el módulo más sólido de la auditoría. TypeScript estricto (`strict: true`) sin ningún `any` ni `@ts-ignore`/`@ts-expect-error` genuino en toda la base de código auditada. Cero usos de `dangerouslySetInnerHTML`. Los 7 usos de `$queryRaw`/`$executeRaw` están correctamente parametrizados (locks de advisory, no concatenación). Manejo de errores centralizado (`lib/api-error.ts`) usado en 77/80 rutas, sin fuga de `error.message`/stack al cliente.

### Hallazgos

**[🟡 MEDIO] ARCH-01 — CSP con `script-src 'unsafe-inline'`**
- [next.config.js:35](next.config.js) — debilita la protección XSS de la CSP contra scripts inline (relevante también para SEC-01). Está documentado explícitamente como limitación conocida del App Router de Next 14 (el RSC payload se inyecta inline, variable por petición, incompatible con hash; nonce rompería el ISR de páginas públicas). Decisión consciente, no negligencia — pero cerrar esta brecha mitigaría parte del impacto de SEC-01.

**[🟡 MEDIO] ARCH-02 — Cálculo de subtotal duplicado entre taquilla y checkout online**
- [app/api/taquilla/sale/route.ts:104](app/api/taquilla/sale/route.ts) reimplementa la suma `price × quantity` en vez de reutilizar `lib/pricing.ts` (usado en `orders/route.ts`). Decisión de negocio válida (sin comisión en taquilla), pero el riesgo de que ambos cálculos diverjan en un futuro cambio es real.

**[🔵 BAJO] ARCH-03** — sin `Strict-Transport-Security` explícito en `next.config.js` (Vercel lo añade automáticamente, pero no está garantizado si se cambia de hosting).
**[🔵 BAJO] ARCH-04** — sin logging estructurado (solo `console.error` crudo, 27 usos, ninguno filtra datos sensibles).
**[🔵 BAJO] ARCH-05** — `app/api/wallet/status/route.ts` sin try/catch ni `handleApiError`.
**[🔵 BAJO] ARCH-06** — import directo de `stripe` en el webhook (fuera del adapter) — justificado (`constructEvent` no tiene equivalente genérico), pero rompe el patrón adapter si algún día se añaden webhooks de SumUp.
**[🔵 BAJO] ARCH-07** — patrón de fetching 100% client-side manual en todas las páginas admin (sin SWR/React Query) — consistente en todo el panel, no es deuda de "migración a medias", pero es una oportunidad de simplificación.

### Verificaciones sin hallazgos
`tsconfig.json` con `strict: true` sin flags debilitantes; cero `any`/`@ts-ignore` reales; cero `dangerouslySetInnerHTML`; queries raw 100% parametrizadas; adapters (`payment-adapter`, `wallet`, `abacus-ai-adapter`, `secrets`) bien encapsulados sin fugas de abstracción relevantes.

---

## 5. Rendimiento y Escalabilidad

### Resumen del estado actual
Sin problemas de N+1 detectados. El cron de reconciliación está correctamente acotado por fecha + batch (no degrada con el tiempo). El test de carga (`loadtest/`) cubre exactamente el escenario crítico (sobreventa con aforo limitado). Los hallazgos son de severidad baja-media, centrados en paginación y carga de librerías pesadas en el panel admin.

### Hallazgos

**[🟡 MEDIO] PERF-01 — `GET /api/admin/shop-orders` sin paginación**
- [app/api/admin/shop-orders/route.ts:21-25](app/api/admin/shop-orders/route.ts) — `findMany` sin `take`/`skip`, con `include` anidado de items+producto. Crece linealmente sin techo con el volumen histórico de tienda, a diferencia de `orders/route.ts` (que sí pagina con `take` acotado a 200). **Recomendación:** aplicar el mismo patrón.

**[🟡 MEDIO] PERF-02 — Sin timeout explícito en llamadas a OpenAI/Abacus.AI**
- [lib/abacus-ai-adapter.ts:206,229](lib/abacus-ai-adapter.ts) — sin `timeout` en el cliente `OpenAI`; usa el default del SDK (10 min). En serverless, una IA colgada puede agotar el límite de ejecución de la plataforma en vez de fallar rápido y controlado.

**[🟡 MEDIO] PERF-03 — Certificado Apple Wallet sin validación de expiración**
- [lib/wallet.ts:244-247](lib/wallet.ts), [lib/apple-wwdr-cert.ts](lib/apple-wwdr-cert.ts) — no se comprueba la fecha de expiración antes de firmar; el fallo, cuando ocurra, solo se loguea con `console.error`, sin alerta activa (a diferencia de `alertPaidButInactiveOrder`, que sí envía email). **Recomendación:** comprobar `notAfter` del certificado y disparar alerta si expira pronto; que el catch de `buildApplePass` también envíe email al equipo.

**[🔵 BAJO] PERF-04** — `<img>` normal en vez de `next/image` en páginas públicas de alto tráfico (`eventos/page.tsx`, `tienda/shop-grid.tsx`, checkout) — impacto reducido porque `images.unoptimized: true` ya está activo, pero se pierde lazy-loading nativo y prevención de layout shift.
**[🔵 BAJO] PERF-05** — 4 componentes de `recharts` en `/admin/estadisticas` y `/admin/gastos` importados sin `next/dynamic({ssr:false})` — solo afecta al panel admin, tráfico bajo.
**[🔵 BAJO] PERF-06** — `maplibre-gl` es dependencia sin uso real (el mapa real es un iframe de Google Maps embebido gratuito) — peso muerto, eliminar o documentar propósito futuro.
**[🔵 BAJO] PERF-07** — `GET /api/admin/users` sin paginación (riesgo bajo por volumen esperado).
**[🔵 BAJO] PERF-08** — `race.js` (k6) sin `thresholds` explícitos; sin evidencia de haberse ejecutado contra un entorno Vercel+Neon real (solo local, documentado como limitación en el propio README).

### Verificaciones sin hallazgos
Sin N+1 en `admin/orders`, `shop-orders`, `scans`, `admin-export`; cron de reconciliación acotado por ventana de fecha + `take: 50` por lote, coste no crece con el histórico; email nunca bloquea la confirmación de compra (ver también sección 7).

---

## 6. Testing y Cobertura

### Resumen del estado actual
La suite de Vitest (33 archivos) tiene **buena cobertura de los flujos críticos de concurrencia y aforo**: 10 compradores concurrentes contra 5 huecos (sobreventa=0), doble submit con idempotencyKey, doble escaneo de QR (secuencial), rol incorrecto en múltiples endpoints admin, aforo agotado. El test de carga k6 (`loadtest/race.js`) confirma 0 sobreventa con 300 VUs contra 200 unidades de stock en la última ejecución documentada. Las brechas más relevantes son de proceso (sin CI, sin BD de test dedicada) y de cobertura en el módulo de reembolsos — coherente con los hallazgos críticos de la sección 3.

### Hallazgos

**[🟠 ALTO] TEST-01 — No existe ningún workflow de CI que ejecute tests/lint/typecheck antes de merge**
- `find .github -type f` solo devuelve dos workflows de cron (`reconcile-payments.yml`, `cleanup-waiting-room.yml`), sin trigger `pull_request`/`push`. Se agrava porque `next.config.js:8-10` tiene `eslint: { ignoreDuringBuilds: true }` — el lint tampoco bloquea el build de Vercel. Solo `tsc` (vía el build de Next) actúa como red de seguridad mínima.
- **Recomendación:** crear `.github/workflows/ci.yml` con `npm ci && npx tsc --noEmit && npm run lint && npm test` como gate obligatorio en PR/push a `main`, con un servicio Postgres de test dedicado.

**[🟠 ALTO] TEST-02 — Sin ninguna herramienta de monitorización/alertas de errores en producción**
- Búsqueda exhaustiva de Sentry/LogRocket/Vercel Analytics/Datadog/New Relic: cero resultados. Un error 500 en producción (fallo de webhook, excepción no capturada) no genera ninguna alerta proactiva — solo logs pasivos de Vercel.
- **Recomendación:** añadir `@sentry/nextjs` (mínimo) antes de abrir venta real con eventos en vivo.

**[🟡 MEDIO] TEST-03 — Sin test de regresión para el endpoint de reembolso/cancelación admin**
- No existía `tests/api/admin-orders.test.ts` que ejercite `PATCH /api/admin/orders/[id]` (`action: 'cancel'|'refund'`) — justo el endpoint del hallazgo PAY-01. **Ya parcialmente cerrado en esta auditoría**: se han generado 2 tests nuevos en `__tests__/audit/` que cubren exactamente este caso y el de reembolso de tienda (PAY-02) — pendiente ejecutarlos y, una vez corregido el bug, integrarlos a la suite estable.

**[🟡 MEDIO] TEST-04 — Tests corren contra la BD de desarrollo real, no una BD de test dedicada/aislada**
- Mitigado con `fileParallelism: false` (serie, `vitest.config.mts:15`) + prefijo `[TEST]` + limpieza en `afterAll`, pero si una suite falla a mitad de camino quedan filas huérfanas en la BD compartida (p.ej. `admin-users.test.ts` no usa prefijo `[TEST]` en los emails, dificultando limpieza manual). **Recomendación:** BD Postgres de test dedicada y efímera en CI.

**[🟡 MEDIO] TEST-05 — Sin test de fallo/timeout real de la pasarela de pago (Stripe/SumUp) en creación de pedido**
- Todos los tests de `orders.test.ts` usan `payment_gateway='mock'` (determinista); ningún test fuerza un `fetch` fallido/timeout durante la creación del checkout en sí (solo el cron de reconciliación mockea `fetch` de SumUp, y solo para su propio flujo).

**[🔵 BAJO] TEST-06** — sin test que combine webhook + cron de reconciliación compitiendo por el mismo pedido (cada camino se testea en aislamiento).
**[🔵 BAJO] TEST-07** — `race.js` de k6 sin `thresholds` vinculantes (el veredicto de corrección lo da un script Node aparte, `teardown.js` — diseño funcional pero atípico).

### Verificaciones sin hallazgos
Aforo agotado, QR duplicado (secuencial), rol incorrecto en admin, y doble submit de checkout están todos bien cubiertos por la suite existente; el bloqueo de deploy ante fallo de `prisma migrate deploy` (`package.json: "build": "prisma migrate deploy && next build"`) es correcto sin ningún workaround/bypass; el manejo del secret `CRON_SECRET` en el workflow de GitHub Actions no tiene fugas en logs.

---

## 7. Integraciones Externas

### Resumen del estado actual
El email transaccional está diseñado de forma resiliente: nunca bloquea la confirmación de compra (el pedido ya está `COMPLETED`/`PAID` en BD antes de intentar el envío), y una configuración SMTP incompleta se detecta explícitamente antes de tocar `nodemailer`. El adapter de IA (Abacus/OpenAI) tiene manejo de errores robusto con fallback controlado. Los hallazgos son de severidad media-baja: falta de timeout explícito en llamadas de IA (ya cubierto como PERF-02) y de validación proactiva de expiración de certificados de Wallet (PERF-03).

### Hallazgos

**[🔵 BAJO] INT-01 — Email sin reintentos automáticos ante fallo SMTP transitorio**
- Solo un intento por envío; recuperación depende de reenvío manual (`/api/orders/[orderId]/send-tickets`, con cooldown de 60s) o de que el admin detecte `emailLastError` en el filtro de pedidos. **Recomendación:** el propio cron de reconciliación (que ya se ejecuta periódicamente) podría reintentar envíos con `emailLastError` no nulo.

**[🔵 BAJO] INT-02 — MapLibre GL es dependencia sin uso real** (duplicado de PERF-06, incluido aquí por completitud de la sección de integraciones — el mapa real es un iframe gratuito de Google Maps, sin API key).

Ver también **PERF-02** (sin timeout en Abacus.AI/OpenAI) y **PERF-03** (sin validación de expiración de certificado Apple Wallet, fallo solo logueado) — ambos aplican directamente a esta sección.

### Verificaciones sin hallazgos
Fallback de Wallet a PDF/email si la generación del pase falla (no bloquea la entrega de la entrada); datos enviados a la IA de sponsors minimizados (sin email/teléfono del sponsor); control de coste real en `sponsors-portal/generate` (máx. 3 intentos, claim atómico).

---

## 8. Preparación para Producción (Go-Live Checklist)

### Resumen del estado actual
El pipeline de build bloquea correctamente el deploy ante fallo de migración (`prisma migrate deploy && next build`, sin bypass). El script de seed usa `upsert` (no destructivo) y credenciales de admin desde variables de entorno, con protección explícita anti-`delete` en `safe-seed.ts`. El `.gitignore` no cubre `.env.test` por defecto (corregido durante esta auditoría, ver más abajo). Los hallazgos más relevantes de esta sección son ya conocidos de secciones anteriores (TEST-01, TEST-02) más algunos específicos de configuración de entorno.

### Hallazgos

**Ver también TEST-01 (sin CI) y TEST-02 (sin monitorización)** — ambos son bloqueantes de facto para un go-live responsable.

**[🟡 MEDIO] PROD-01 — `scripts/seed.ts` sin protección de código contra ejecución accidental en producción**
- Solo hay protección anti-`delete` (aborta si el script contiene `delete`/`deleteMany`); no hay ninguna comprobación de que `DATABASE_URL` no sea de producción antes de ejecutar `upsert`. El README ya advierte del riesgo (reescribe la contraseña del admin con el `ADMIN_PASSWORD` del `.env` local vigente), pero es una protección de disciplina humana, no de código. Además crea datos de ejemplo con `status: PUBLISHED` (evento `noche-inaugural-2025`, IDs de `TicketType` hardcodeados) sin marcador `[TEST]`.
- **Recomendación:** añadir un guard en `safe-seed.ts` que aborte si `DATABASE_URL` no apunta a `localhost`/`127.0.0.1` salvo flag explícito `ALLOW_PROD_SEED=1`.

**[🔵 BAJO] PROD-02** — `NEXT_DIST_DIR`/`NEXT_OUTPUT_MODE` usadas en `next.config.js:3-4` pero no documentadas en `.env.example` (opcionales, con fallback seguro).

**[🔵 BAJO] PROD-03** — `eslint.ignoreDuringBuilds: true` en `next.config.js` — el lint no bloquea el build de Vercel (relacionado con TEST-01).

### Verificaciones sin hallazgos
`docker-compose.yml` solo para desarrollo local, credenciales no reutilizables en producción; `package.json`'s `build` script bloquea el deploy si `prisma migrate deploy` falla, sin ningún flag de skip; el secret `CRON_SECRET` en GitHub Actions no tiene fugas en logs (masking automático del contexto `secrets.*`); todas las variables usadas en código relevantes para el flujo de negocio están documentadas en `.env.example`.

### Acción tomada durante esta auditoría
Se ha creado `.env.test` con `TEST_URL`/`TEST_ADMIN_EMAIL`/`TEST_ADMIN_PASSWORD` para la fase de pruebas dinámicas (no ejecutada, ver limitación al inicio de este informe) y se ha añadido `.env.test` explícitamente al `.gitignore` (el patrón previo `.env*.local` no lo cubría) para evitar que esas credenciales queden expuestas en un futuro commit.

### Preguntas abiertas
- ¿Existe ya una estrategia de backup/point-in-time-recovery configurada en el dashboard de Neon? No verificable desde el repositorio.
- ¿Hay un plan de rollback documentado (fuera del repo) si un despliegue de Vercel introduce una regresión?
- ¿Quién recibe la alerta si el workflow de GitHub Actions de reconciliación deja de dispararse (fallo de la plataforma de CI, no del código)?

---

## Checklist final de bloqueo para producción

| Bloqueante | Hallazgo | Motivo |
|---|---|---|
| 🔴 Sí | PAY-01 | Reembolso real de dinero roto — riesgo legal/reputacional directo con dinero de clientes |
| 🔴 Sí | SEC-01 | XSS ejecutable con sesión de staff activa (taquilla) |
| 🔴 Sí | SEC-02 | Fuga de PII de compradores sin autenticación |
| 🟠 Sí | PAY-02 | Reembolsos de tienda no devuelven dinero ni liberan stock |
| 🟠 Sí | PAY-03 | Riesgo de "regalar" ventas reales si se olvida configurar la pasarela |
| 🟠 Sí | SEC-03 | Doble entrada física a un evento en vivo (control de acceso es la función más crítica del sistema en el momento del evento) |
| 🟠 Recomendado antes de la primera venta con tráfico real | TEST-01, TEST-02 | Sin red de seguridad de CI ni visibilidad de errores en producción |
| 🟡 Recomendado, no bloqueante | DATA-01 | Migrar a `Decimal` puede hacerse en paralelo a la primera venta, pero antes de acumular mucho histórico |
| 🟡 Recomendado, no bloqueante | Resto de hallazgos 🟡/🔵 | Mejoras de robustez, rendimiento y mantenibilidad — abordables en iteraciones posteriores |

**Los 6 hallazgos marcados como bloqueantes deben corregirse antes de abrir venta real de entradas.** El resto de hallazgos 🟡/🔵 no impiden un lanzamiento controlado, pero se recomienda priorizar TEST-01/TEST-02 (CI + monitorización) muy pronto después, dado que son la única forma de detectar con rapidez si alguna de estas correcciones (o futuras) introduce una regresión durante un evento en vivo.

---

## Tests de regresión generados (Fase 5)

5 tests en `__tests__/audit/`, siguiendo el patrón de la suite existente (BD real de dev, sin mocks de Prisma). **No se han podido ejecutar** en este entorno (sin Node.js accesible) — ejecutar `npm test` antes de aplicar cualquier fix para confirmar que fallan hoy, y de nuevo después para confirmar que pasan:

| Test | Hallazgo | Archivo |
|---|---|---|
| IDOR en pedidos de tienda | SEC-02 | [__tests__/audit/security-shop-order-idor.test.ts](__tests__/audit/security-shop-order-idor.test.ts) |
| XSS en impresión de entradas | SEC-01 | [__tests__/audit/security-xss-pdf-html.test.ts](__tests__/audit/security-xss-pdf-html.test.ts) |
| Cancelar pedido pagado no reembolsa | PAY-01 | [__tests__/audit/payments-cancel-completed-card-no-refund.test.ts](__tests__/audit/payments-cancel-completed-card-no-refund.test.ts) |
| Reembolso de tienda no libera stock | PAY-02 | [__tests__/audit/payments-shop-order-refund-no-stock-release.test.ts](__tests__/audit/payments-shop-order-refund-no-stock-release.test.ts) |
| Doble escaneo concurrente de QR | SEC-03 | [__tests__/audit/security-scan-race-condition.test.ts](__tests__/audit/security-scan-race-condition.test.ts) |

## Cobertura no verificada

⚠️ Toda la Fase 4 (pruebas dinámicas: HTTP real contra `localhost:57810`, navegación de UI, errores de consola JS, verificación en mobile viewport, interacción con formularios) — **no verificado, requiere entorno con Node.js accesible**. Recomendación: una vez el equipo tenga el servidor arrancado, repetir al menos las comprobaciones de autenticación/autorización (Fase 4 del checklist de la skill) contra el servidor real para confirmar en caliente los hallazgos SEC-01/SEC-02/SEC-03, que son los de mayor impacto y los más fáciles de verificar dinámicamente.
