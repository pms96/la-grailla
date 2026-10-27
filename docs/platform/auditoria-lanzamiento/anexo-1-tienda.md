# Auditoría 01 — Módulo TIENDA ONLINE (La Grailla)

Fecha: 2026-10-27. Solo lectura de código y docs; no se ha ejecutado nada (ni tests, ni BD, ni red). Todas las referencias son `fichero:línea` del árbol actual en `main`.

**Documentos leídos antes de empezar:** `docs/platform/revision-modulos-y-plantillas.md`, `doc/audit-report.md` (y `doc/remediation-plan.md`), `docs/platform/m6-producto.md`, `m7-operacion.md`, `lib/modules/registry.ts`.

**Aviso sobre `doc/audit-report.md`:** es anterior a las correcciones. Varios de sus hallazgos ya están cerrados en código (SEC-02 IDOR de pedidos de tienda → token firmado; PAY-02 reembolso/stock de tienda → `invalidateShopOrder`; PAY-05 dedup del webhook → el insert va después de procesar; DATA-01 → `Decimal(10,2)`). No se reportan como nuevos.

**Hechos ya conocidos que NO se reportan como nuevos** (solo se matizan en la sección 5): la tienda cobra con la cuenta de Entradas hasta que se guarde `shop_payment_gateway`; el pago real y Blob no están probados de extremo a extremo; `stripe_publishable_key` sin uso.

Escala de confianza: **VERIFICADO** = leído el código y la cadena de llamadas completa; **PROBABLE** = el código lo hace pero depende de un comportamiento externo que conozco pero no he podido comprobar (Stripe/SumUp); **HIPÓTESIS** = no confirmable sin ejecutar o sin la pasarela.

---

## 0. Resumen ejecutivo

| ID | Prio | Hallazgo (una línea) | Esfuerzo | Confianza |
|---|---|---|---|---|
| TI-01 | P0 | Guardar un producto desde el panel pisa el stock de TODAS sus variantes con los valores que cargó la pantalla (sobreventa) | S | VERIFICADO |
| TI-02 | P0 | Pedido PENDING retiene el stock 24 h, el carrito se borra antes de pagar y no hay vuelta atrás: el propio comprador se queda sin la última unidad | M | VERIFICADO |
| TI-03 | P0 | Pago que llega tras cancelar/caducar (o cancelar el admin un PENDING con sesión viva): cobrado sin pedido, sin reembolso automático; SumUp sin webhook ni vigilancia tras CANCELLED | M | VERIFICADO (mecanismo) / PROBABLE (frecuencia) |
| TI-04 | P0 | El panel de pedidos NO muestra talla/color ni teléfono: el vendedor no puede preparar el envío | S | VERIFICADO |
| TI-05 | P0 | Cero información de venta a distancia: sin condiciones de venta, desistimiento/devoluciones, «IVA incluido», gastos de envío ni aceptación/enlace a privacidad en el checkout | S-M | VERIFICADO (ausencia) / PROBABLE (exigencia legal: que lo confirme el abogado) |
| TI-06 | P1 | El vendedor no recibe aviso de pedido nuevo | S | VERIFICADO |
| TI-07 | P1 | Email de confirmación: fallo sin reintento ni rastro; SMTP sin configurar = silencio; la pantalla afirma «te hemos enviado un email» siempre | M | VERIFICADO |
| TI-08 | P1 | Reembolso solo total y sin registro (importe, id, fecha, quién); no hay devoluciones parciales ni flujo de devolución | M | VERIFICADO |
| TI-09 | P1 | Reembolso con clave de idempotencia fija: un fallo de Stripe se repite 24 h; y un reembolso hecho a mano en Stripe no se puede reflejar en el panel | S | PROBABLE |
| TI-10 | P1 | «Probar conexión» de la pestaña Tienda prueba la cuenta de ENTRADAS cuando la clave está enmascarada | S | VERIFICADO |
| TI-11 | P1 | Al dar cuenta propia a la tienda, los pedidos ya cobrados en la cuenta de Entradas dejan de poder verificarse/reembolsarse | M | VERIFICADO |
| TI-12 | P1 | Reintento de creación devuelve `checkoutUrl: null`: comprador atrapado en «Confirmando el pago…» sin enlace; la página se rinde a los 30 s sin salida | S-M | VERIFICADO |
| TI-13 | P1 | Precio/stock/producto cambiados entre carrito y pago: el servidor cobra otra cosa sin avisar; líneas inválidas se descartan en silencio; carrito sin caducidad ni revalidación | M | VERIFICADO |
| TI-14 | P1 | Acaparamiento de stock sin pagar: `items` sin tope, sin captcha, 24 h de retención | S-M | VERIFICADO |
| TI-15 | P1 | Sin envío, IVA, cupones ni descuentos, y el esquema no tiene dónde guardarlos | M-L | VERIFICADO |
| TI-16 | P1 | Sin email de envío, sin seguimiento visible y la confirmación no se puede reabrir (el email no lleva enlace) | M | VERIFICADO |
| TI-17 | P1 | Textos fijos de La Grailla/festival en checkout, confirmación y email; enlace a `/eventos` aunque no haya módulo Entradas | S | VERIFICADO |
| TI-18 | P1 | Pedidos del panel: sin exportación, sin paginación, sin trazabilidad (quién/cuándo), notas sin UI, abandonados mezclados, sin nº correlativo | M | VERIFICADO |
| TI-19 | P2 | Deadlock posible al reservar varias líneas en orden distinto → 500 | S | PROBABLE |
| TI-20 | P2 | Cron: pedido con importe que no cuadra se cuenta como «completado», queda PENDING para siempre reteniendo stock | S | VERIFICADO |
| TI-21 | P2 | El reembolso de tienda no está exento de módulo apagado / licencia BLOCKED (sí el de entradas) | S | VERIFICADO |
| TI-22 | P2 | Inventario: slug duplicado = 500; renombrar talla borra su stock; sin historial de movimientos ni alertas; umbral fijo 3; `ShopOrderItem` sin snapshot del nombre | M | VERIFICADO |
| TI-23 | P2 | Accesibilidad del checkout y copy/formatos (precios `19.99€`, CP solo 5 dígitos, sin país, estados sin aria-live) | S-M | VERIFICADO |
| TI-24 | P2 | Fichas sin URL ni SSR en plantillas no-Drop; stock exacto público en `/api/products`; CDN 60 s con stock viejo | M | VERIFICADO |
| TI-25 | P2 | Webhook no contrasta importe (solo el camino verify); `staff` cualquiera (TAQUILLA) lee PII de pedidos; stripe ítem único / mínimo 0,50 € | S | VERIFICADO |

---

## 1. Lo que ya está bien (qué se revisó y funciona)

- **Reserva de stock atómica** (caso 3a): `reserveShopStock` hace `updateMany ... where stock >= qty, decrement` (`lib/product-stock.ts:91-99`) dentro de `prisma.$transaction` junto con la creación del pedido (`app/api/shop/orders/route.ts:77-126`). Dos compradores sobre la última unidad: el segundo `UPDATE` re-evalúa el `WHERE` tras el bloqueo de fila, devuelve `count 0` y lanza `OUT_OF_STOCK` (409) que revierte toda su transacción. No hay lectura-modificación-escritura en la compra. No puede quedar stock negativo por ventas.
- **Precios y totales se recalculan en servidor** desde `Product.price` (`route.ts:83-90`); el cliente solo manda `productId/quantity/size/color`. Columnas monetarias `Decimal(10,2)` (`prisma/schema.prisma:337,378,406`); el total se redondea al guardar y es lo que viaja a la pasarela (`createdOrder.totalAmount`, `route.ts:176`). Precio ≥ 0 y ≤ 100.000, cantidad 1..100 (`route.ts:29`, `app/api/admin/products/route.ts:20`).
- **Importe cobrado vs total** (`lib/reconciliation/shared.ts:15-47`): si la pasarela dice un importe distinto, no se completa y se avisa (1 vez/día).
- **Mock bloqueado en producción** (`lib/payment-adapter.ts:548-552`): no se regalan pedidos si falta la pasarela.
- **Compensación si falla la sesión de pago** (`route.ts:199-219`): libera stock, cancela y anula la `idempotencyKey` para poder reintentar.
- **Idempotencia de creación**: `idempotencyKey @unique` + carrera `P2002` resuelta devolviendo el pedido existente (`route.ts:59-70,128-145`). Stripe usa `checkout_${orderId}` como clave (`payment-adapter.ts:240`).
- **Webhooks**: firma verificada (`payment-adapter.ts:165`); dedup `ProcessedWebhookEvent` tras procesar (`lib/payments/webhook-handler.ts:57-66`); `completeShopOrder` solo transiciona `PENDING→PAID` con `updateMany` condicionado (`lib/reconciliation/tienda.ts:19-22`), así que duplicados y desorden no repiten email ni cambian estado. Endpoint propio `stripe-tienda` con su secreto.
- **Cron de reconciliación** con cola justa y liberación temprana en `EXPIRED` (`app/api/cron/reconcile-payments/route.ts:36-40,159-163`); corta con 502 si no avanza nada.
- **Máquina de estados** de pedidos (`lib/shop-order-status.ts`) y `invalidateShopOrder` con compare-and-swap + rollback si falla la pasarela (`lib/reconciliation/tienda.ts:136-179`); no repone stock de lo ya enviado (`refundReturnsStock`).
- **IDOR de pedido cerrado**: token HMAC en la URL de confirmación (`lib/access-token.ts:43-67`), `GET /api/shop/orders/[id]` lo exige (`route.ts:15`).
- **Módulo apagado**: registro default-deny por prefijo (`lib/modules/registry.ts:73-80`) + middleware 404 (`lib/tenant/middleware.ts` `gateByModuleAndLicense`); `/tienda/[slug]` comprueba el módulo también dentro del handler (`app/(public)/tienda/[slug]/page.tsx:17`); sitemap condicionado (`app/sitemap.ts:20,50`); webhooks y cron nunca se cortan (dinero en vuelo).
- **Checkout (a11y básica)**: `<Label htmlFor>`, `autoComplete`, `inputMode`, errores con `role="alert"`, foco al primer error, `noValidate` con validación propia (`shop-checkout-client.tsx:49-72,171-340`). Rate limit compartido en Postgres (`lib/rate-limit.ts`).
- **Dashboard de tienda** (`lib/shop-stats.ts`): solo cuenta pedidos cobrados, agregado en BD, día de Madrid, stock bajo y más vendidos.
- **SumUp: el endpoint de reembolso ya NO apunta a `/checkouts`**: `payment-adapter.ts:401-432` lee el checkout, saca la transacción cobrada y reembolsa `POST /v1.0/merchants/{code}/payments/{tx}/refunds`. El plan anotaba lo contrario (ver sección 5).

---

## 2. Hallazgos P0

### TI-01 — Guardar un producto sobrescribe el stock de todas sus variantes con valores viejos
**Prioridad propuesta:** P0 · **Esfuerzo:** S · **Confianza:** VERIFICADO

**Problema.** El formulario de producto manda SIEMPRE el stock de todas las variantes si el producto ya tenía variantes, aunque el admin solo cambie el precio o la foto, y el servidor lo aplica como valor absoluto.

**Evidencia.**
- `app/admin/productos/page.tsx:147`: `const shouldSyncVariants = !editing || hadVariants || stockTouched || ...` → con `hadVariants` verdadero, `variants` (stock de cada combinación, `:149-153`) va en cada guardado.
- `openEdit` rellena `stockByKey` con `p.variants` de la lista que se cargó al abrir la página (`:107-113`), no con una lectura fresca.
- `lib/product-stock.ts:47-52`: `nextStock = stockMap.get(...)` y `tx.productVariant.update({ data: { stock: nextStock } })` si difiere; es un SET, no un delta.

**Escenario.** Lunes 10:00 el admin abre `/admin/productos` (Camiseta M: 5). A las 10:20 se venden 3 (stock real 2). A las 11:00 el admin edita la descripción o el precio y guarda: `variants` lleva M:5 → el stock vuelve a 5. Se pueden vender 3 unidades inexistentes. Lo mismo al revés (restock en otra pestaña) y con las unidades devueltas por caducidad.

**Impacto.** Sobreventa real con dinero cobrado → reembolsos manuales, pedidos prometidos que no se pueden servir, clientes enfadados el día de más tráfico (el del «drop»). Es el riesgo más probable del módulo porque ocurre sin ningún error visible.

**Solución.** (1) Servidor: el PATCH solo toca stock de combinaciones cuyo valor haya cambiado respecto a lo que el cliente cargó, o mejor, endpoint/acción de **ajuste por delta** (`stock: { increment: n }` con motivo) y el absoluto solo con comparación optimista (`expectedStock` → 409 si cambió). (2) Cliente: mandar `variants` solo con las filas que el admin tocó (`stockTouched` por clave). (3) Refresco de la fila al abrir el diálogo. (4) Registrar movimiento (ver TI-22).

---

### TI-02 — Retención de 24 h, carrito borrado antes de pagar y sin liberación al volver
**Prioridad propuesta:** P0 · **Esfuerzo:** M · **Confianza:** VERIFICADO

**Problema.** El stock se reserva al crear el pedido PENDING y no se libera hasta que la pasarela confirma caducidad o pasan 24 h. El cliente vacía el carrito justo antes de redirigir a la pasarela, y `cancelUrl` apunta a `/tienda` sin liberar nada.

**Evidencia.**
- Reserva en la creación: `route.ts:106`.
- Carrito borrado antes de que se pague: `shop-checkout-client.tsx:115` (`writeCart([])`) y redirección en `:118`.
- `cancelUrl: baseUrl + '/tienda'` sin id ni acción (`route.ts:181`); no hay ruta de cancelación (grep `cancel` en `app/api/shop`: ninguna).
- Liberación: cron `MAX_AGE_MS = 24 h` (`reconcile-payments/route.ts:25`) o `EXPIRED` de la pasarela; Stripe Checkout caduca por defecto a las 24 h (la sesión se crea sin `expires_at`, `payment-adapter.ts:219-241`). El doc del plan acepta que `FAILED` no se libera (`m6-producto.md:60`).

**Escenario.** Quedan 2 unidades de la sudadera L. Ana pulsa «Pagar», en la pasarela falla 3DS o se arrepiente y pulsa atrás. Vuelve a `/tienda/checkout`: «Carrito vacío». Vuelve a añadir la sudadera: `Sin stock suficiente` — la retiene SU propio pedido PENDING durante 24 h (y el de cualquiera que abandone). Con stock pequeño de merch (decenas de unidades) basta un puñado de abandonos (frecuentes en tarjeta) para dejar un producto «agotado» durante un día mientras hay unidades físicas.

**Impacto.** Ventas perdidas en el pico de lanzamiento, tickets de soporte («no me deja comprar» / «me cobró y no…»), y confusión de stock en el panel.

**Solución.** (a) Caducidad corta propia: `expires_at` de Stripe (30-60 min, mínimo 30) y `valid_until` de SumUp, de modo que el cron libere por `EXPIRED` en minutos, no a las 24 h (el cron ya lo soporta). (b) No vaciar el carrito hasta ver el pedido PAID (limpiar en la página de confirmación al pasar a PAID) o guardar el carrito en el pedido PENDING para «reanudar». (c) `cancelUrl` → `/tienda/checkout?cancelado=<id>&t=...` que llama a un `POST /api/shop/orders/[id]/cancel` (solo PENDING, token) y restaura el carrito. (d) Un solo pedido PENDING por `buyerEmail`+carrito (reusar o cancelar el anterior al crear otro).

---

### TI-03 — Pago que llega tras cancelar/caducar: cobrado sin pedido y sin reembolso automático
**Prioridad propuesta:** P0 · **Esfuerzo:** M · **Confianza:** VERIFICADO (mecanismo); frecuencia PROBABLE; comportamiento de SumUp sin caducidad HIPÓTESIS

**Problema.** Cuando el pedido ya está CANCELLED (por cron, por fallo de sesión o por el admin) y entra el pago, `completeShopOrder` solo avisa por email al operador y no hace nada más; el stock ya se restituyó y puede estar vendido.

**Evidencia.**
- `lib/reconciliation/tienda.ts:19-30`: `updateMany where PENDING` → `count 0` → `alertPaidButInactiveOrder(...)`; fin. Sin reintento de reserva, sin reembolso, sin aviso al comprador.
- `alertPaidButInactiveOrder` solo envía si hay `admin_email`/`notify_email_tienda` (`reconciliation/shared.ts:53-55`); si no, solo `console.error`.
- Ni la liberación del cron ni `invalidateShopOrder(CANCELLED)` expiran la sesión de pago viva (grep `expire(` en repo: nada). El cron cancela a las 24 h exactas desde la creación del pedido, ANTES de que expire la sesión Stripe (se crea después del pedido): ventana de minutos en la que el comprador aún puede pagar.
- El admin puede cancelar un PENDING (`invalidateShopOrder` permite `CANCELLED` sin cobro, `tienda.ts:117-123`) con la sesión abierta.
- SumUp no tiene webhook (`payment-adapter.ts:310`): tras CANCELLED, el pedido deja de entrar en las consultas del cron (`status: 'PENDING'`, `reconcile-payments/route.ts:92-103`) y `GET /api/shop/orders/[id]` solo verifica si está PENDING (`[orderId]/route.ts:28-33`). Un pago SumUp posterior no deja ni alerta.
- Agravante: la pantalla del comprador dice para CANCELLED/REFUNDED «No se ha realizado ningún cargo» (`shop-confirmation-client.tsx:94`), falso en este caso y en REFUNDED.

**Escenario A (admin).** El admin cancela un PENDING «sospechoso»; el cliente tenía la pestaña de Stripe abierta, paga a los 10 min → cobrado, pedido CANCELLED, stock liberado; el único rastro es un email (si hay destinatario).
**Escenario B (SumUp).** Comprador abre el checkout, lo deja 25 h y paga: el cron ya canceló y liberó; SumUp cobró; nadie se entera hasta que el comprador reclama.

**Impacto.** Dinero retenido sin pedido (riesgo de contracargo, legal y reputacional) y trabajo manual en el peor momento.

**Solución.** (1) Al cancelar/expirar, llamar a `checkout.sessions.expire` (Stripe) y, donde exista, anular el checkout de SumUp. (2) En `completeShopOrder`, rama `CANCELLED`: intentar **reanimar** (re-reservar atómicamente con `reserveShopStock` en una tx; si hay stock → `PAID` + email) y, si no, **reembolsar automáticamente** (clave `late_refund_${id}`) y notificar a comprador y vendedor; registrar el evento. (3) Incluir en el cron los CANCELLED recientes (7 días) con `paymentId` para SumUp (comprobar si el checkout acabó PAID). (4) Cambiar el texto de la pantalla según estado (REFUNDED: «Te hemos devuelto el importe»).

---

### TI-04 — El panel de pedidos no enseña talla/color ni teléfono
**Prioridad propuesta:** P0 · **Esfuerzo:** S · **Confianza:** VERIFICADO

**Problema.** La tarjeta de pedido pinta solo `producto xN` y dirección.

**Evidencia.** `app/admin/pedidos/page.tsx:128`: `(order?.items ?? []).map((i) => \`${i?.product?.name ?? ''} x${i?.quantity ?? 0}\`)`; el teléfono (`shippingPhone`) y el email se ven a medias (email sí, teléfono no, `:112-129`). `size`/`color` existen en `ShopOrderItem` (`schema.prisma:407-408`) pero ninguna pantalla de admin los muestra (grep `item.size` en `app/admin`: solo en productos, no en pedidos). El email de confirmación tampoco los incluye (`reconciliation/tienda.ts:34-39`).

**Escenario.** Primer pedido: «Camiseta x2». ¿M o L, negra o blanca? El vendedor solo puede abrir la BD o preguntar al comprador. Preparar y enviar es imposible desde el panel.

**Impacto.** Bloquea el cumplimiento de la primera venta; errores de talla = devoluciones.

**Solución.** Mostrar `size · color` por línea (y precio unitario), teléfono, notas y botón «copiar dirección/etiqueta»; añadirlos al email. Vista de detalle de pedido (drawer) con línea de tiempo (TI-18). Test de componente que falle si falta talla/color.

---

### TI-05 — Sin información precontractual de venta a distancia ni consentimiento en el checkout
**Prioridad propuesta:** P0 (riesgo legal) · **Esfuerzo:** S-M · **Confianza:** ausencia VERIFICADO; obligación legal PROBABLE (confirmar con el abogado que ya revisa)

**Problema.** No existe ninguna página ni texto de condiciones de venta, derecho de desistimiento/devoluciones, plazos y costes de envío, ni aviso de «IVA incluido». El checkout recoge datos personales sin aceptación ni enlace a privacidad.

**Evidencia.**
- Páginas legales existentes: `aviso-legal`, `cookies`, `privacidad` (`app/(public)/legal/*`). La búsqueda de `desistimiento|devolución|condiciones de venta|términos` en `app` y `lib` solo encuentra textos de menores/edad de entradas (`lib/age-warning.ts:13`, `lib/minor-authorization-text.ts`).
- `shop-checkout-client.tsx`: formulario `:171-240` sin casilla de aceptación ni enlace; el texto de pie (`:314-317`) dice «Merch bajo pedido — te confirmamos el envío por email».
- `privacidad/page.tsx:24-25` menciona «pedidos» en genérico y es texto plano.
- Sin envío, IVA ni moneda configurables (TI-15): no hay forma de mostrar «IVA incluido / envío X €».

**Escenario.** Primera venta a un consumidor español: no se le informa antes de pagar del desistimiento de 14 días (o de su exclusión justificada si es producto bajo pedido/personalizado), ni de gastos de envío; reclamación o inspección de consumo.

**Impacto.** Riesgo regulatorio y de contracargos; también un prerrequisito para que Stripe/SumUp aprueben el negocio (suelen pedir política de devoluciones visible). Confianza del comprador.

**Solución.** (1) Páginas `legal/condiciones-de-venta` y `legal/devoluciones` editables (campo `legal_*` por cliente, como `legal_notice`) y enlazadas en pie, ficha y checkout. (2) Casilla/aviso «He leído y acepto las condiciones de venta y la política de privacidad» obligatoria y registrada (`acceptedTermsAt`, versión) en `ShopOrder`. (3) Línea «IVA incluido · Envío: …» en carrito y resumen. (4) Plantilla de texto por defecto marcada «revisar con asesor». No lo resuelvo yo: validar redacción con el abogado.

---

## 3. Hallazgos P1

### TI-06 — El vendedor no se entera de los pedidos nuevos
**P1 · S · VERIFICADO.** Solo hay dos emails de la tienda al operador, ambos de error (`reconciliation/shared.ts:32-36,53-55`); `completeShopOrder` solo escribe al comprador (`tienda.ts:44`). El único aviso es el dashboard (`/admin`). **Escenario:** pedido a las 23:00, el vendedor lo ve al día siguiente. **Solución:** email (y/o webhook) al `notify_email_tienda` por pedido pagado con líneas, talla y dirección; resumen diario de pendientes de envío; badge en el menú.

### TI-07 — Email de confirmación: sin reintento, sin rastro y mensaje engañoso
**P1 · M · VERIFICADO.**
- `tienda.ts:44-70`: si `sendMail` falla o lanza, solo `console.error`; el pedido ya es PAID y `count` será 0 en cualquier reintento de webhook/cron, así que **nunca se reenvía**. Un fallo del servidor/función a mitad (timeout SMTP) pierde el email igual.
- `lib/mailer.ts:93`: sin SMTP configurado devuelve `success:false` y nadie lo ve; `smtp_enabled` por defecto `'false'` (`lib/config.ts:26`) y no hay comprobación de que el módulo con venta tenga correo (grep en `lib/onboarding.ts`: nada).
- `shop-confirmation-client.tsx:133`: afirma «Te hemos enviado un email de confirmación» siempre.
**Escenario:** cliente nuevo sin SMTP (o contraseña caducada): todos los compradores pagan y no reciben nada; soporte se llena. **Solución:** columna `confirmationEmailSentAt`/`emailError`; envío fuera de la ruta crítica con reintento por cron (ya existe); botón «Reenviar» en el pedido; banner en panel «Tienda activa sin correo configurado» y bloqueo suave al activar pasarela real; la pantalla debe decir «Guarda esta referencia» y solo prometer email si `confirmationEmailSentAt`.

### TI-08 — Reembolsos: solo totales, sin registro y sin devolución parcial
**P1 · M · VERIFICADO.** `tienda.ts:157` reembolsa siempre `order.totalAmount`; la ruta (`app/api/admin/shop-orders/[id]/route.ts:10-16`) no acepta importe ni líneas. El `refundId` se descarta (`tienda.ts:157-164` solo mira `success`), no hay `refundedAmount/refundedAt/por quién/motivo` en `ShopOrder` (`schema.prisma:370-399`) y no hay concepto de devolución por línea ni de stock parcial. El adaptador Stripe ya soporta importe (`payment-adapter.ts:277`) y SumUp también (`:417`) aunque `capabilities.partialRefunds` dice `false` para SumUp (`:311`, incoherente). **Escenario:** «me llegó una camiseta rota de las dos»; el único camino es reembolsar el pedido entero. **Impacto:** el estándar Shopify es devolución parcial por línea con reposición opcional y motivo. **Solución:** modelo `ShopRefund {orderId, amount, items[], reason, providerRefundId, restock, createdById, createdAt}`; `ShopOrder.refundedAmount`; estado `PARTIALLY_REFUNDED`; endpoint `POST /api/admin/shop-orders/[id]/refund {items|amount, restock, reason}`; clave de idempotencia por `ShopRefund.id`.

### TI-09 — Idempotencia fija del reembolso y estado «ya reembolsado fuera del panel»
**P1 · S · PROBABLE** (depende de la semántica de Stripe: guarda y repite el resultado de la primera petición con esa clave, incluidos los 4xx, durante 24 h).
`tienda.ts:157`: la clave es `refund_${order.id}` siempre. Si el primer intento falla por algo corregible (p. ej. saldo insuficiente en una cuenta nueva, un error 4xx), el reintento desde el panel recibe la misma respuesta cacheada durante 24 h. Y si el vendedor ya reembolsó desde el Dashboard de Stripe, el panel recibe error y revierte el estado (`:158-165`): ese pedido no puede marcarse REFUNDED (los estados planos no lo permiten, `shop-order-status.ts:20-25`), seguirá contando como ingreso (`shop-stats.ts:6`) y su stock no se repondrá.
**Solución:** clave `refund_${order.id}_${intentoN}` (o `ShopRefund.id`); al recibir «charge already refunded» tratarlo como éxito y registrar; acción «Marcar como reembolsado fuera del panel» con confirmación.

### TI-10 — «Probar conexión» de la pestaña Tienda prueba la cuenta equivocada
**P1 · S · VERIFICADO.** `app/api/admin/config/test-gateway/route.ts:32,38` lee `stripe_secret_key` / `sumup_api_key` (Entradas) cuando llega la máscara; el componente compartido `payment-account.tsx:34-36` manda `values[k('stripe_secret_key')]` (que tras guardar es la máscara) sin indicar el ámbito. **Escenario:** el vendedor guarda las claves `shop_*`, pulsa «Probar conexión» → «Conexión con Stripe correcta» (¡de Entradas!); la clave de la tienda puede estar mal y no se detecta hasta el primer comprador. Es exactamente lo que ese botón debía evitar. **Solución:** parámetro `scope: 'entradas'|'tienda'` en el body y claves por ámbito; test de regresión.

### TI-11 — Cambiar a cuenta propia deja pedidos previos sin verificar ni reembolsar
**P1 · M · VERIFICADO.** El pedido solo guarda `paymentProvider` y `paymentId` (`schema.prisma:379-380`), no la cuenta. Todos los caminos posteriores resuelven credenciales con el ámbito actual: `getPaymentProviderByName(..., 'tienda')` en reembolso (`tienda.ts:154`), cron (`reconcile-payments/route.ts:171,194`) y confirmación (`[orderId]/route.ts:35`). `paymentKeys` (`payment-adapter.ts:526-530`) devuelve las claves de Entradas mientras no exista la fila `shop_payment_gateway` y las de la tienda después. Al guardar la pasarela de la tienda (que el doc prevé hacer para La Grailla «cuando toque»): (i) los PENDING creados en la cuenta vieja no se pueden verificar con la nueva (error → `stillPending`, luego se cancelan a las 24 h aunque estuvieran pagados), (ii) los pedidos ya PAID no se pueden reembolsar desde el panel (la sesión no existe en la cuenta nueva). Además `hasConfigRow` traga errores y devuelve `false` (`lib/config.ts:166-172`), con lo que un fallo transitorio de BD haría usar las claves de Entradas.
**Solución:** guardar `paymentAccount` (`'entradas'|'tienda'`) en el pedido al crear la sesión y resolver credenciales por ese campo; migración que rellene `'entradas'` a los existentes; hacer el cambio de cuenta un paso guiado (avisar de pedidos PENDING en vuelo).

### TI-12 — Reintento de creación: `checkoutUrl: null` y comprador sin salida
**P1 · S-M · VERIFICADO.**
- `route.ts:59-70,135-144`: si la `idempotencyKey` ya existe responde `success:true, checkoutUrl:null` aunque el pedido siga PENDING con sesión de pago.
- Cliente: `shop-checkout-client.tsx:118-122`: sin `checkoutUrl` hace `router.push` a confirmación; tras un fallo de red el mensaje invita a reintentar con la misma clave (`:128`, «no se cobrará dos veces»).
- Confirmación: sondea 12 veces cada 2,5 s y se queda en «Confirmando el pago…» indefinidamente (`shop-confirmation-client.tsx:58,104-120`), sin botón «Ir a pagar» ni «Cancelar».
**Escenario:** respuesta perdida en 4G; el comprador reintenta; el pedido existe y nunca llega a la pasarela. **Solución:** guardar `checkoutUrl` (o recuperarlo: `sessions.retrieve`/`GET checkout` de SumUp) y devolverlo en el reintento y en el `GET` del pedido PENDING; en la pantalla PENDING mostrar «Continuar con el pago» y «Cancelar pedido» tras el sondeo; validar la `idempotencyKey` (UUID, longitud) en el esquema (`route.ts:23`: hoy `z.string().optional()`).

### TI-13 — Precio/stock/producto cambiados entre el carrito y el pago
**P1 · M · VERIFICADO.**
- El carrito es `localStorage` sin caducidad ni revalidación (`lib/shop-cart.ts:62-88`), guarda `price` y `name` del momento de añadir; `checkout` solo lo lee (`shop-checkout-client.tsx:45-48`) y pinta ese total (`:230`).
- El servidor cobra el precio actual sin comparar (`route.ts:83-90`).
- Productos desactivados o inexistentes se saltan en silencio (`route.ts:84`): se cobra menos y solo se enteraría leyendo el email.
**Escenario:** subes el precio de 20 € a 25 € el viernes; carritos del jueves siguen enseñando 20 € y Stripe muestra 25 €: abandono y reclamaciones. Un producto agotado/retirado entre medias se «pierde» sin avisar.
**Solución:** `POST /api/shop/cart/validate` (o el mismo `orders` en modo `dryRun`) que devuelva precios/stock actuales y un diff; checkout lo llama al cargar y antes de pagar, muestra «El precio de X ha cambiado» y exige confirmar; el servidor acepta opcionalmente `expectedTotal` y responde 409 con el diff si no coincide; no descartar líneas en silencio (400 con la lista).

### TI-14 — Acaparamiento de stock sin pagar
**P1 · S-M · VERIFICADO.** `items` solo exige `.min(1)` sin máximo (`route.ts:34`), cada línea hasta 100 unidades (`:29`), el endpoint es anónimo con 10 peticiones/min/IP (`:39`) y sin captcha, y la retención dura 24 h (TI-02). **Escenario:** un bot (o un competidor) reserva todo el catálogo en un par de peticiones y mantiene el inventario «agotado» todo el día; en un lanzamiento tipo «drop» es el ataque típico. También el límite por IP penaliza a compradores legítimos tras NAT (wifi de feria). **Solución:** `items.max(20)`, tope de unidades por producto configurable (p. ej. 5), cupo de PENDING por email/IP, captcha/Turnstile al crear pedido, retención corta (TI-02) y validación de email real.

### TI-15 — Sin envío, IVA, cupones ni descuentos (y el esquema no tiene dónde guardarlos)
**P1 (decidir el esquema ya) · M-L · VERIFICADO.** Búsqueda en todo el repo: no hay ninguna clave de envío/IVA de tienda (`lib/config-ownership.ts:44-45` solo pasarela y textos), ni modelo de cupón, ni campos `subtotal/shippingAmount/taxAmount/discountAmount/currency` en `ShopOrder`; la moneda está escrita a mano (`route.ts:177`). El total es `Σ price×qty` (`route.ts:86`). **Impacto:** envío gratis implícito (margen), imposible vender fuera de España, imposible desglosar IVA o emitir factura (el Informe 2.3 ya lo anota). **Por qué P1 ahora:** añadir columnas tras tener pedidos obliga a migrar histórico; mejor crear ya `subtotal, shippingAmount, taxAmount, discountAmount, currency, taxIncluded` (con default = total actual) y `ShopOrderItem.taxRate`, aunque las reglas lleguen después. **Solución:** tarifas de envío por zona/umbral (`ShippingRate`), cupones (`Coupon` con límites/uso) calculados SOLO en servidor, y mostrar el desglose en carrito/checkout/email. En Stripe enviar líneas reales (hoy una sola línea «Pedido tienda X» × 1, `payment-adapter.ts:222-229`).

### TI-16 — Sin email de envío ni seguimiento; la confirmación no se puede reabrir
**P1 · M · VERIFICADO.** `trackingNumber` solo se usa en admin y en el filtro (`grep trackingNumber`: `app/admin/pedidos/page.tsx`, `shop-orders/[id]/route.ts:15,54`, `lib/shop-order-filters.ts:27`); ni la pantalla de confirmación ni ningún email lo muestran, y cambiar a SHIPPED no envía nada. El email de confirmación promete «Te avisaremos cuando lo enviemos» (`tienda.ts:67`) y no lleva enlace a la página del pedido (`:44-67`), así que el comprador solo puede ver su pedido en la URL con token de la redirección inicial. **Solución:** transición `SHIPPED` → email con transportista + nº + enlace de seguimiento; enlace con token a `/tienda/confirmacion/{id}?t=` en el email de confirmación; mostrar estado/seguimiento en esa página; campo `carrier`.

### TI-17 — Textos y enlaces fijos de La Grailla/festival en una plataforma multi-cliente
**P1 · S · VERIFICADO.** `shop-confirmation-client.tsx:204` («¡Nos vemos en la caseta! 🍻» en el recibo), `reconciliation/tienda.ts:51` («pedido de merchandising»), `shop-checkout-client.tsx:144,315` («merch», «Merch bajo pedido»), `shop-grid.tsx:238-241` («las entradas de los eventos están el plan» [sic] y botón «Ver eventos» a `/eventos`, que da 404 si el cliente no tiene Entradas), `app/(public)/tienda/page.tsx:77-80`. El resto de la plataforma ya extrajo estos textos (sección 4.3 del doc de plantillas). **Escenario:** el primer cliente que venda ropa de otra marca enseña «caseta» y «merch bajo pedido» en su recibo y su email. **Solución:** `brand.name` + claves `shop_*` editables; quitar enlace a `/eventos` si `!modules.includes('entradas')`; test que prohíba cadenas de marca en `app/(public)/tienda` y `lib/reconciliation/tienda.ts`.

### TI-18 — Backoffice de pedidos: exportación, trazabilidad y escala
**P1 · M · VERIFICADO.**
- Sin exportación: `lib/admin-export.ts` y `app/api/admin/export` no incluyen pedidos de tienda (grep `shopOrder` en ellos: nada). La gestoría/almacén piden CSV el primer mes.
- Sin trazabilidad: `ShopOrder` solo tiene `updatedAt` (`schema.prisma:392-393`); no hay tabla de eventos (quién cambió estado, cuándo, motivo); el campo `notes` existe en API (`shop-orders/[id]/route.ts:17,55`) pero la UI no lo expone (`app/admin/pedidos/page.tsx`).
- Sin paginación: `GET /api/admin/shop-orders` (`route.ts:21-25`) trae todo con `include` anidado, y la UI lo repite en cada pulsación de búsqueda (debounce 250 ms, `page.tsx:46-49`). PERF-01 del informe antiguo sigue abierto.
- Los pedidos cancelados por abandono/502 se mezclan con los reales (y todos usan `status` visibles); la referencia visible es `id.slice(0,8)` de un cuid (ordenada en el tiempo, no correlativa; `shop-confirmation-client.tsx:148`).
- Cambio plano de estado no es atómico (lee y luego escribe, `route.ts:41-46`): dos admins pueden pisarse.
**Solución:** tabla `ShopOrderEvent`, `orderNumber` correlativo (secuencia), vista detalle con notas/línea de tiempo, paginación por cursor, filtro «ocultar cancelados por abandono», export CSV/XLSX (con talla/color y dirección), `updateMany where status = current`.

---

## 4. Hallazgos P2

### TI-19 — Deadlock al reservar varias líneas
**P2 · S · PROBABLE.** `reserveShopStock` recorre `items` en el orden del carrito (`product-stock.ts:82`) y cada `updateMany` bloquea la fila de la variante; dos transacciones con carritos [A,B] y [B,A] a la vez pueden formar un interbloqueo; Postgres aborta una (40P01) y `handleApiError` responde 500 genérico (`route.ts:159`, `api-error.ts`). **Solución:** ordenar `reserveItems` por `(productId,size,color)` antes del bucle y reintentar 1 vez ante 40P01/P2034.

### TI-20 — Pago con importe distinto: queda PENDING para siempre reteniendo stock
**P2 · S · VERIFICADO.** `completeShopOrder` retorna sin cambiar nada si el importe no cuadra (`tienda.ts:14-15`); el cron lo cuenta como `completed` y hace `continue` (`reconcile-payments/route.ts:190-198`), sin liberar; en las pasadas siguientes sigue entrando en la lista «abandonados» (`createdAt < minCreated` sin tope, `:100-103`). Alerta 1 vez al día. Con stock escaso el producto queda bloqueado indefinidamente. **Solución:** estado/flag `NEEDS_REVIEW` visible en el panel, contador `completed` real y decisión explícita (reembolsar o aceptar).

### TI-21 — Reembolso de tienda no exento con módulo apagado o licencia BLOCKED
**P2 · S · VERIFICADO.** `isLicenseExempt` exime solo `PATCH /api/admin/orders/{id}` (entradas) (`registry.ts:152-153`); `PUT /api/admin/shop-orders/{id}` sigue bajo el dueño `tienda` → 404 con módulo apagado, 503 en BLOCKED. Un cliente que baja de plan o cae en impago deja a sus compradores sin poder obtener reembolso. Consecuente con el criterio del propio registro («el dinero del comprador no depende de que el cliente pague»). **Solución:** eximir también `PUT/PATCH` de reembolso de tienda (o una ruta `…/refund` dedicada) y `isFullAccessRestricted('tienda')` dentro del handler para impedir lo que no sea dinero.

### TI-22 — Inventario: huecos operativos
**P2 · M · VERIFICADO.**
- Slug único sin control: se calcula del nombre al crear (`products/route.ts:48`) y un nombre repetido da `P2002` → `internal_server_error` genérico (`api-error.ts` no mapea P2002); la UI dice «No se pudo guardar el producto» (`productos/page.tsx:168-171`). Un nombre solo con caracteres no latinos produce slug vacío.
- Cambiar tallas/colores borra variantes y su stock (`product-stock.ts:38-42`); renombrar «M» a «Media» pone el stock a 0.
- Sin historial de movimientos de stock, sin distinguir «reservado» de «disponible» en el panel, umbral de poco stock fijo = 3 (`shop-stats.ts:7`), sin aviso por email de reposición.
- `ShopOrderItem` no guarda nombre/SKU del producto (`schema.prisma:401-414`): renombrar o desactivar cambia el histórico; el mensaje «Sin stock suficiente» también sale cuando el comprador manda talla vacía en un producto con tallas (`product-stock.ts:89-107`).
**Solución:** `StockMovement` (delta, motivo, pedido/usuario), umbral por producto, snapshot `name/sku` en la línea, slug con sufijo, y mensaje específico para opción no elegida.

### TI-23 — Accesibilidad y formato del checkout
**P2 · S-M · VERIFICADO.** Errores sin `aria-describedby` al campo (`shop-checkout-client.tsx:182-188`), sin resumen de errores, sin `required`/`aria-required`; botones de talla/color sin `aria-pressed` (`shop-grid.tsx:370-392,413-436`); el estado «Confirmando el pago…» no está en `role=status/aria-live` (`shop-confirmation-client.tsx:104-120`); precios con `toFixed(2)` + `€` pegado («19.99€») en vez de formato `es-ES` («19,99 €») en todo el flujo; CP limitado a 5 dígitos y sin selector de país (`:59`), válido solo para España peninsular; el servidor ni siquiera valida CP ni longitudes máximas (`route.ts:17-22`, `string().min(1)` sin `max`).

### TI-24 — Escaparate: URL/SEO, exposición y caché
**P2 · M · VERIFICADO.** En plantillas no-Drop la ficha es un diálogo (`shop-grid.tsx:439+`) sin URL ni indexación y el listado es CSR (`:60-72`), aunque `/tienda/[slug]` ya existe para cualquier plantilla; `/api/products` es público y devuelve el stock exacto por variante (`app/api/products/route.ts:13-17`); `/tienda` va con caché de CDN 60 s + 30 s (`next.config.js:140-142`), de modo que el aviso «Quedan N» puede estar desfasado hasta ~90 s (el servidor sigue siendo la fuente de verdad: solo fricción). Sin búsqueda ni ordenación.

### TI-25 — Menores
**P2 · S · VERIFICADO.** (a) El camino de webhook no pasa importe a `completeShopOrder` (`order-reconciliation.ts:16`) así que la comprobación de cuadre solo actúa en confirmación/cron; el importe lo fija el servidor al crear la sesión, riesgo bajo pero asimétrico. (b) `allowShopOrderAccess` acepta cualquier sesión de staff (`access-token.ts:61-67`, incluida TAQUILLA) y el token no caduca. (c) Stripe rechaza importes < 0,50 € → 502 genérico y pedido cancelado. (d) La confirmación imprime «RECIBO» sin IVA (puede confundirse con un justificante fiscal).

---

## 5. Casos límite solicitados — trazabilidad por escenario

**(a) Último stock, dos compras simultáneas.** Seguro por diseño (sección 1): UPDATE condicional atómico dentro de transacción; el perdedor recibe 409 sin efectos. Riesgos relacionados que SÍ existen: TI-01 (el panel repone stock «de la nada»), TI-19 (deadlock con carritos en orden distinto), TI-14 (acaparamiento) y `release` que suma sobre un stock que el admin fijó a mano.

**(b) Webhooks duplicados / desfasados / fuera de orden.** Duplicados y orden: seguro (transiciones condicionadas a PENDING + dedup tras procesar; carrera P2002 tolerada). `expired` después de `succeeded`: se ignora. **Pago tras cancelar/caducar:** NO resuelto (TI-03): solo email al operador; sin recuperación ni reembolso. Webhook que falla a mitad: el reintento repite el trabajo pero no reenvía el email (TI-07).

**(c) Abandono tras retención bancaria / pago pendiente.** Estado resultante: PENDING con `paymentId`; el cron (5 min, `m7-operacion.md:109`) verifica; `EXPIRED` libera pronto, `FAILED` no, y todo lo demás a las 24 h (TI-02). Se restituye el stock «demasiado pronto» respecto a una sesión aún pagable solo en la ventana de minutos descrita en TI-03; «demasiado tarde» es el problema habitual (24 h). No hay conciliación del pedido cuyo pago llegó con importe distinto (TI-20).

**(d) Doble clic / reintento.** El botón se deshabilita (`submitting`); la clave se reutiliza para reintentos y se renueva tras error (`shop-checkout-client.tsx:80-82,111`). Robusto contra duplicados reales; el fallo es la UX del reintento (TI-12) y el carrito vacío (TI-02). Dos pestañas con el mismo carrito crean dos pedidos con claves distintas (reserva doble hasta la caducidad).

**(e) Cobrado pero email fallido.** TI-07: sin reintento ni rastro; el comprador y el vendedor no se enteran.

**(f) Precios cambiados entre carrito y pago.** TI-13: el servidor manda y cobra el precio vigente; el cliente enseña el viejo; sin aviso ni confirmación.

---

## 6. Qué pasa si el módulo se apaga (sección 4 del encargo)

Verificado en `lib/modules/registry.ts` + `lib/tenant/middleware.ts` (modo plataforma):
- **Se corta (404):** `/tienda/**` (incluidos checkout y fichas), `/api/shop/**` (crear pedido), `/api/products`, `/api/admin/products`, `/api/admin/shop-orders`, `/api/admin/shop-stats`, `/admin/productos`, `/admin/pedidos`; fuera del sitemap y de la portada/menú (`app/(public)/page.tsx:281`, `app/sitemap.ts:20,50`). La ficha `/tienda/[slug]` además comprueba el módulo dentro del handler (`[slug]/page.tsx:17`).
- **Sigue vivo a propósito (dinero en vuelo):** `/api/webhooks/*` y `/api/cron/*` (reconcilian y envían email de pedidos de tienda aunque el módulo esté apagado: `reconcile-payments/route.ts:90-103`), y las LECTURAS `GET /tienda/confirmacion/*` y `GET /api/shop/orders/{id}` (`registry.ts:150-151`) — con token. Esas lecturas pueden además completar un pago (`[orderId]/route.ts:37-38`): es intencionado.
- **Datos:** siguen en la BD del cliente; reactivar el módulo los recupera (límite ya declarado en el doc).
- **Gating dentro de handlers con dinero:** `POST /api/shop/orders` y `GET /api/products` no comprueban el módulo (confían en el middleware); el test «módulo apagado = cero datos» solo cubre GET (doc, sección 1). En modo normal (instalación única, La Grailla) todos los módulos están activos: no hay corte.
- **Lagunas:** reembolsos de tienda no exentos (TI-21); pedidos PENDING con stock reservado se liberan por el cron aunque el módulo esté apagado (correcto) pero el admin no puede verlos ni gestionarlos. Para cuenta de pago: si el módulo Entradas está apagado y no existe `shop_payment_gateway`, la tienda resuelve `mock` y en producción lanza error → **todos los checkouts devuelven 502** sin ningún aviso en el panel (`payment-adapter.ts:528,548`; grep de avisos de configuración incompleta: no hay).

## 7. Matiz sobre «hechos ya conocidos»

- **Reembolso SumUp:** el comentario y el código actuales (`payment-adapter.ts:396-432`) ya consultan el checkout y reembolsan la transacción vía `/v1.0/merchants/{code}/payments/{tx}/refunds`; `docs/platform/m6-producto.md:111` sigue listándolo como error conocido → **doc desfasada**. El endpoint nuevo no se ha probado contra SumUp real (PROBABLE que sea correcto; falta prueba en sandbox). `capabilities.partialRefunds=false` contradice el código (`:311` vs `:417`).
- **Cuenta de cobro de la tienda:** además de lo ya sabido, TI-10 (probar conexión) y TI-11 (cambio de cuenta) son consecuencias concretas del diseño de continuidad.
- **Pago real y Blob sin probar de extremo a extremo:** coincide con lo observado: los tests de tienda usan `payment_gateway = 'mock'` (`tests/api/shop-orders.test.ts:20-26`); no hay test de idempotencia/reintento, de pago tardío ni de concurrencia de la reserva en la suite estándar (solo `loadtest/race.js`, k6, no ejecutado en esta auditoría).

## 8. Orden de ataque recomendado (antes de la primera venta real)

1. **Bloqueantes de operación (días, S):** TI-01, TI-04, TI-10, TI-06, TI-17.
2. **Retención y recuperación de dinero (M):** TI-02 (caducidad corta + no vaciar carrito + cancelar), TI-03 (expirar sesión + reanimar/reembolsar), TI-12.
3. **Legal y contenido (S-M, con el abogado):** TI-05; decidir el esquema de TI-15 antes de tener pedidos.
4. **Primera semana de soporte:** TI-07, TI-08/09, TI-16, TI-18, TI-13, TI-14, TI-11 (antes de dar cuenta propia a La Grailla).
5. **Roadmap:** TI-19 a TI-25.

Pruebas que faltan y deberían existir antes de vender: (1) test de TI-01 (guardar producto con stock viejo no pisa); (2) pago tardío tras CANCELLED; (3) reintento idempotente con pedido PENDING; (4) dos transacciones concurrentes de último stock contra Postgres real (la suite actual no lo ejercita); (5) E2E con Stripe en modo test y SumUp sandbox, incluyendo webhook real, reembolso total/parcial y email.
