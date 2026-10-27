# Auditoría 03 — Contabilidad, facturación y conciliación (La Grailla)

Fecha: 2026-10-27. Solo lectura: no se ha editado nada, ni ejecutado tests/BD/servidores. Única ejecución: dos one-liners de `node` aritméticos (sin tocar el repo) para comprobar el redondeo de CO-06.

**Aviso fiscal/legal.** Todo lo que toca IVA, facturación, Verifactu/TicketBAI, retención de documentación y RGPD es **criterio técnico, no asesoramiento legal**. Cada punto lleva «qué validar con gestoría/abogado». Las fechas de calendario normativo (Verifactu) deben confirmarse: mi información puede estar desfasada.

**Nivel de confianza:** VERIFICADO = leído en el código citado (y, cuando se dice «grep», comprobado por ausencia en todo `app/ lib/ components/ prisma/ packages/`). PROBABLE = el mecanismo está verificado pero el efecto depende de comportamiento externo (pasarela, Postgres). HIPÓTESIS = inferencia.

**Lo ya resuelto y NO repetido** (de `docs/platform/revision-modulos-y-plantillas.md`): float→Decimal en BD, IVA del gasto desde pedido (ya con `ivaEfectivo`), máquina de estados de pedidos de tienda, importe cobrado vs total, roles por módulo, sesiones revocables, test «módulo apagado = cero datos», sitemap por módulos. Lo que sigue abierto del informe anterior y confirmo aún abierto: temporada CERRADA sin efecto, borrado duro sin huella, `extraer-imagen` con URL arbitraria, margen incompleto (CO-03), sin paginación.

---

## 0. Qué ofrece de verdad hoy el módulo (contrastado)

| Pieza | Qué es realmente | Evidencia |
|---|---|---|
| Compras | Catálogo de artículos+precios por proveedor, planificador por temporada, generación de pedidos por proveedor, export Excel/PDF **para enviar a mano**. **Nada se envía solo.** | `app/api/admin/compras/**`; `app/admin/compras/_components/tab-pedidos.tsx:103` («registro interno, no se ha notificado al proveedor») y `:298`; grep `sendMail|mailto|wa.me|nodemailer` en `app/api/admin/compras lib/compras app/admin/compras app/admin/gastos lib/gastos` = 0 |
| Gastos | Libro de gastos por temporada: concepto, categoría, proveedor, base, IVA %, fecha, nº doc, tipo (Factura/Abono/Otro). Export Excel/PDF | `prisma/schema.prisma:910-933`, `app/api/admin/gastos/**` |
| Ingresos | **Caja manual** por día (concepto libre de una lista + importe). No se alimenta de pedidos | `schema.prisma:940-955`; `app/api/admin/ingresos/resumen/route.ts:10-13` |
| Temporadas | Contenedor anual (`anio`) con vínculo opcional desde Evento/Producto/ShopOrder/SponsorRequest | `schema.prisma:751-774` |
| Margen/dashboard | Un único número «Margen (temporada)» en el dashboard de Entradas; `/admin/gastos` muestra solo gasto (total, anterior, por categoría, comparativo). Las cards de ingresos/margen se retiraron de Gastos | `app/admin/_components/admin-dashboard.tsx:62-76,167-178`; `app/api/admin/gastos/resumen/route.ts:55-70` |
| Cuadre de caja taquilla | **Sí existe**: Ventas por día separa online / taquilla tarjeta / taquilla efectivo / gratis y compara caja manual «Entradas» vs efectivo del sistema | `lib/ventas-por-dia.ts:35-39,123-127`; `app/api/admin/stats/ventas-por-dia/route.ts` |

Posicionamiento: el módulo se llama «Contabilidad» pero es un **libro operativo de compras, gastos y caja**, no contabilidad ni facturación. Es la raíz de varios hallazgos (CO-01, CO-03, CO-09).

---

## 1. Lo que ya está bien (breve, con evidencia)

1. **Aislamiento por módulo y rol sólido.** Rutas de contabilidad con dueño en el registro (`lib/modules/registry.ts` reglas `/admin/compras|gastos|ingresos`, `/api/admin/compras|gastos|ingresos` → `contabilidad`); default-deny (`ownerOfPath` null ⇒ 404 en `lib/tenant/middleware.ts` `gateByModuleAndLicense`); un rol restringido solo pasa por módulos propios (`lib/modules/access.ts:pathAllowedForModules`); la sesión se contrasta con BD y se invalida si cambia el rol (`lib/auth.ts:86-87`). Cada handler exige `role === 'ADMIN'`. Cruces entre módulos protegidos con `isModuleEnabled` (`gastos/resumen/route.ts:35-36`, `ventas-por-dia/route.ts:59`, `season-link.ts`).
2. **Regla del dueño «no enviar pedidos a proveedores» cumplida** en código y en copy de UI (ver tabla). Falta test que la blinde (CO-15).
3. **Dinero en BD con `Decimal(10,2)`** (`schema.prisma` 239…945) y capa que devuelve `number` (`lib/prisma.ts:25-75`). Snapshot de precio/IVA/descuento en `LineaPedido` y de IVA en `Gasto` ⇒ un cambio de IVA del artículo **no** reescribe pedidos ni gastos ya creados.
4. **Reconciliación de cobro**: importe y moneda contrastados con la pasarela antes de completar (`lib/reconciliation/shared.ts:23-30`), CAS atómico `PENDING→COMPLETED` (`entradas.ts:25-35`), reembolso con clave idempotente (`entradas.ts:163`), webhooks idempotentes y registro «procesado» tras procesar (`webhook-handler.ts`), cron de reconciliación con cola justa.
5. **Ventas por día en hora de Madrid con DST correcto** (`ventas-por-dia.ts:43-73`) y buckets de canal/tarjeta/efectivo/gratis.
6. **Protección anti-fórmula en CSV** (`app/api/admin/export/route.ts:10-20`) y BOM UTF-8.
7. **Abonos de proveedor**: `importeSinIva` admite negativos y el tipo «Abono» existe (`gasto-dialog.tsx:148`).
8. Compras: estados de pedido solo avanzan, con CAS (`pedidos/[id]/route.ts:17-21,59-69`); regeneración solo toca BORRADOR (`pedidos/generar/route.ts:78-101`).

---

## 2. Hallazgos

Resumen de prioridades: **P0**: CO-01, CO-02. **P1**: CO-03 a CO-12. **P2**: CO-13 a CO-22.

---

### CO-01 — No existe facturación legal ni datos fiscales (emisor ni cliente) — **P0 (legal/posicionamiento)**
**Problema.** La plataforma solo emite *confirmaciones de compra* y entradas en PDF; no hay modelo de factura, serie, numeración correlativa, NIF del emisor ni del comprador, desglose de IVA ni tipos por producto/entrada. El «recibo» de la tienda se imprime con texto «RECIBO» sin IVA. Sin embargo la UI de la tienda confirma «RECIBO» y el email dice «Confirmacion de compra»: un comprador (o una empresa) puede tomarlos por comprobante fiscal.
**Evidencia.**
- grep `factura|invoice|nif|cif|vat|rectificativ|numeraci` en `app lib components prisma packages` (sin tests): 0 coincidencias fuera del libro de gastos de *compras*. `schema.prisma` `Order` (254-293) y `ShopOrder` (370-399): sin NIF, sin base/IVA, sin número correlativo; id = cuid; la «Referencia» es `order.id.slice(0,8)` (`lib/tickets.ts:164`).
- `lib/brand/brand.ts:25-27` `legalName` existe; **no** hay NIF/domicilio fiscal en `Brand` ni en `AppConfig` (`lib/config.ts`, solo `legal_notice` de texto libre, línea 18).
- `tienda/confirmacion/.../shop-confirmation-client.tsx:168-196`: «RECIBO», `Total` sin base/IVA.
- `lib/tickets.ts:163`: `Total: x EUR`, sin «IVA incluido».
- No se aplica ningún IVA a la venta: el precio de `TicketType`/`Product` es un único `price`.
**Escenario.** Un cliente (promotora con NIF) vende entradas a 20 € y merchandising. Un comprador pide factura; o la gestoría pide libro de facturas emitidas con base+cuota por tipo. No hay nada que dar: el cliente tendría que facturar a mano fuera del sistema, sin vínculo con los pedidos. Además, una «Confirmación» sin datos del emisor puede no cumplir ni como factura simplificada.
**Impacto.** Legal/soporte: es la primera pregunta de cualquier cliente serio en validación comercial. Riesgo para el cliente si cree que ya factura. No es un bug, es una carencia que debe quedar **explícita** en el posicionamiento.
**Solución propuesta (por fases; no construir un motor de facturación propio al principio).**
1. *Mínimo antes de vender (S–M)*: campos fiscales del emisor en Configuración→Contabilidad/General (razón social, NIF, domicilio, régimen de IVA); mostrar «IVA incluido» y datos del emisor en confirmación/PDF/email; renombrar «RECIBO/Confirmación» a «Justificante de compra (no es factura)» salvo que se cumpla lo siguiente; documentarlo en la ficha comercial.
2. *Fase 2 (M)*: `TaxRate` por `TicketType`/`Product` (0/4/10/21 + exento, con motivo) y **snapshot** de base/cuota/tipo por línea en la venta (nuevo `OrderLine` o columnas en `Ticket`; ver CO-13); cálculo de IVA incluido (el precio de venta al consumidor es IVA incluido).
3. *Fase 3 (L)*: o bien (a) **integración** con un proveedor de facturación certificado (Holded, Quipu, Billin, Facturae…) enviando pedido→factura; o bien (b) numeración propia con serie por tenant, huecos prohibidos (tabla `InvoiceSequence` con `SELECT … FOR UPDATE`/secuencia por serie), factura simplificada hasta el límite legal aplicable, rectificativas ligadas (CO-02), y cumplimiento del sistema antifraude (Verifactu/TicketBAI según territorio). **Recomendación: (a)**: si la plataforma emite facturas pasa a ser «sistema informático de facturación» con obligaciones de certificación/declaración responsable, y eso es mucho más caro que exportar bien (CO-05).
**Validar con gestoría/abogado:** tipos de IVA aplicables a cada entrada/producto (según actividad: espectáculo cultural, discoteca/baile, merchandising); si el ticket puede ser factura simplificada y con qué contenido; obligaciones Verifactu/TicketBAI y su calendario vigente (comprobar fecha actual de entrada en vigor); OSS para tienda con envíos a otros Estados UE (entradas a eventos presenciales suelen tributar donde se celebra el evento).
**Esfuerzo.** Fase 1 S; Fase 2 M; Fase 3 L (integración M, motor propio L+).
**Confianza.** VERIFICADO (ausencia por grep y lectura de esquema/plantillas). Los criterios fiscales: criterio técnico.

---

### CO-02 — Reembolsos: sin ledger, sin rectificativa y **no se sincronizan los hechos en la pasarela** — **P0 (riesgo transaccional)**
**Problema.** (a) Un reembolso hecho **desde el panel de Stripe/SumUp** (lo habitual en soporte) nunca llega a la BD: el webhook solo procesa pago correcto y caducidad. El pedido sigue `COMPLETED`, las entradas `VALID` y entran en ingresos. (b) Dentro de la app el reembolso es **solo total**, no deja rastro (sin `refundedAt`, importe ni id de reembolso) y sobrescribe el estado; los ingresos lo «olvidan» porque solo suman `COMPLETED`. (c) Disputas/contracargos sin tratamiento.
**Evidencia.**
- `lib/payment-adapter.ts:43-45` `WebhookEvent` solo `payment_succeeded | payment_expired | ignored`; `:172-187` solo `checkout.session.*`; `lib/payments/webhook-handler.ts:64-65`. No hay `charge.refunded`/`charge.dispute.*` (grep `refund|dispute|chargeback` en el handler: 0).
- `schema.prisma:254-293` `Order` sin campos de reembolso; `:295-315` `Ticket` sin precio.
- `lib/reconciliation/entradas.ts:152-155` (estado sobrescrito a REFUNDED), `:160-175` (reembolso por el `totalAmount` completo), `:187-198` (la anulación de entradas va en una transacción posterior: si falla, queda REFUNDED con entradas VALID; ya señalado en el informe previo).
- `gastos/resumen/route.ts:61-66` ingresos = solo `status: 'COMPLETED'`.
- Reembolso de un pedido taquilla en efectivo: `invalidateOrder` cambia estado sin ningún movimiento de caja (no hay `Ingreso` negativo ni apunte).
**Escenario.** Soporte reembolsa a un comprador en el panel de Stripe. El comprador conserva su QR válido, lo reenvía a un amigo y entra; el pedido sigue sumando en ventas y margen. A fin de mes la gestoría concilia pasarela vs pedidos y no cuadra, sin pista de por qué. Segundo caso: el cliente devuelve 5 € de una entrada de 20 € (parcial): no es posible.
**Impacto.** Dinero y acceso: fraude de acceso, descuadre mensual, imposibilidad de emitir rectificativa con referencia, y cada discrepancia acaba en soporte.
**Solución.**
1. *Webhook (M)*: mapear `charge.refunded`/`refund.updated`/`charge.dispute.created` a nuevos eventos neutros; handler idempotente que marca el pedido (total→`REFUNDED` + anula entradas; parcial→registro) y avisa al operador cuando no pueda aplicar la regla.
2. *Ledger de pagos (M)*: tabla `PaymentEvent`/`Refund` (orderId o shopOrderId, tipo, importe, id de pasarela, fecha, origen: panel/pasarela) y campos `refundedAmount`/`refundedAt` en `Order`/`ShopOrder`; los ingresos pasan a ser **neto = cobrado − reembolsado** con fecha del movimiento.
3. *Parcial y rectificativa (M–L)*: reembolso por entradas/líneas (requiere precio por ticket, CO-13); documento de rectificación numerado que referencia el original (cuando exista CO-01 fase 3).
4. Reembolso de efectivo en taquilla: pedir método/caja y generar apunte negativo en caja.
**Esfuerzo.** M (webhook+ledger) / L (parcial+rectificativa).
**Confianza.** VERIFICADO (código y ausencia por grep). Escenario: PROBABLE (depende de que soporte use el panel de la pasarela, muy habitual).
**Validar con gestoría:** tratamiento de la factura rectificativa y del IVA en reembolsos parciales/cancelaciones de eventos.

---

### CO-03 — No hay un resultado económico único ni fiable; el «Margen» del dashboard es parcial y bruto — **P1**
**Problema.** Hay **dos «resultados» que se excluyen mutuamente** y ninguno es completo: (1) dashboard «Margen» = entradas online+taquilla (Order `COMPLETED`, con comisión e IVA) + sponsors pagados − gastos con IVA; **ignora** Tienda y la caja manual; (2) `/admin/ingresos` «Balance — lo que queda al final» = caja manual − gastos; **ignora** pedidos online, tienda y sponsors. Mezcla importes con IVA incluido en ambos lados (ni neto ni «caja» coherente) sin rotularlo.
**Evidencia.** `gastos/resumen/route.ts:55-70` (ingresos=Entradas+Patrocinio; margen = ingresos − gastoTotal con IVA, sin tienda ni `Ingreso`); `ingresos/resumen/route.ts:10-13,36-38` (comentario: a propósito no incluye online ni patrocinios); `admin-dashboard.tsx:167-178` («Margen (temporada)» sin matiz; solo aparece si hay eventos enlazados); `ShopOrder.temporadaId` existe (`schema.prisma:~385`) pero no se suma. Un cliente **solo Contabilidad (+Tienda)** no tiene ningún resumen: `app/admin/page.tsx:25-33` cae a `ShopDashboard`/`CoreDashboard` y el margen solo vive en `AdminDashboard` (Entradas).
**Escenario.** El gerente ve «Margen +3.200 €», pero la tienda de la temporada (4.000 € de ventas) no está y la barra cobrada en caja tampoco. O ve el «Balance» de caja con un valor distinto y no sabe cuál manda. En validación comercial un número equivocado en el panel resta más credibilidad que no tener número.
**Impacto.** Confianza del cliente y soporte; decisiones de negocio con cifra parcial.
**Solución.** Un único informe **P&L por temporada/evento** (módulo-aware: suma solo módulos activos) con tres bloques: ingresos netos (online, taquilla efectivo/tarjeta, tienda, sponsors, caja manual no duplicada), costes (compras/gastos), resultado; con selector «con IVA / sin IVA» y rótulo explícito. Evitar doble cómputo: el concepto «Entradas» de la caja manual debe tratarse como **conciliación** del efectivo de taquilla (ya hay `diferenciaCaja`), no como ingreso adicional. Mientras tanto: renombrar «Margen bruto (con IVA, solo entradas y patrocinios)». Mover el widget al propio módulo Contabilidad para clientes sin Entradas.
**Esfuerzo.** M (informe) / S (rotulado).
**Confianza.** VERIFICADO.

---

### CO-04 — Fugas de dominio «caseta/feria» hacia otros clientes (navegación y copy) — **P1 (bloquea demos)**
Clasificación pedida (grep `caseta|feria|grailla`, sin tests/docs, en `app/admin app/api/admin components lib app/(public)`):

**Fuga a otros clientes (corregir):**
| Dónde | Texto | Quién lo ve |
|---|---|---|
| `app/admin/_components/admin-shell.tsx:66` | Grupo de menú **«Caseta»** (Compras/Gastos/Ingresos) | Todo cliente con Contabilidad |
| `app/admin/compras/page.tsx:48` | «Catálogo, comparativa de precios y pedidos de la caseta» | idem |
| `app/admin/gastos/page.tsx:119` | «Contabilidad real de la caseta por temporada» | idem |
| `app/admin/ingresos/page.tsx:100` | «Caja física de la caseta…» | idem |
| `app/admin/compras/_components/temporada-selector.tsx:88` | Nombre por defecto de temporada **«Feria de Septiembre {año}»** | idem, al crear la primera temporada |
| `app/admin/eventos/_components/events-manager.tsx:281`, `app/admin/productos/page.tsx:463` | «temporada de Compras/Gastos de la caseta» | clientes con Contabilidad + Entradas/Tienda |
| `lib/compras/constantes.ts:1-24` | Categorías de artículo (Refrescos, Cervezas, Espirituosos, Aguas, Vinos), de gasto («Bebidas y bar», «Alquiler de puesto», «Hielo y perecederos») e ingreso («Barra», «Comida») | idem |
| `app/admin/gastos/_components/gasto-desde-pedido-dialog.tsx:58` | Categoría fija `'Bebidas y bar'` al registrar gasto desde pedido | idem |
| Placeholders `tab-articulos.tsx:233,247`, `importar-articulos-dialog.tsx:296,304`, `gasto-dialog.tsx:112`, `ingreso-dialog.tsx:110` | «Coca Cola 33cl», «Lata 33cl», «Alquiler del puesto», «caja del viernes noche» | idem |
| `lib/abacus-ai-adapter.ts:108,112,124,260-261` | Prompt de IA: «proveedores de bebidas para una caseta de feria» + lista cerrada de 6 categorías (`CATEGORIAS_VALIDAS`) | Clientes que usen «Importar listado» |
| `app/(public)/tienda/confirmacion/[orderId]/_components/shop-confirmation-client.tsx:204` | «¡Nos vemos en la caseta! 🍻» en el recibo **público** | **Compradores finales** de cualquier cliente con Tienda (P1 alto: es cara pública) |
| `app/(public)/sponsors/page.tsx:47` | «Tu marca en la caseta» | Solo si el cliente elige plantilla Feria (se oculta con banner); verificar en la auditoría de sponsors |
| `lib/minor-authorization-text.ts:9,13` | Fallback `la caseta "LA GRAILLA"` cuando `organizer` está vacío | HIPÓTESIS: comprobar que ningún cliente nuevo llega con `organizer` vacío (fuera del alcance contable) |

**Legítimo (seed del tenant legacy / identificadores técnicos):** `lib/brand/brand.ts` (`LA_GRAILLA_SEED`, `legacySeedTheme`; el cliente neutro no lo hereda), `lib/config.ts` valores marcados en `LEGACY_SEED_KEYS` (vacíos fuera del legacy), `lib/wallet.ts`/`lib/ticket-pdf.ts` (ramas «La Grailla conserva…»), `lib/tenant/*`, `lib/secrets.ts`, claves técnicas `lagrailla_cookie_consent` (`components/cookie-banner.tsx:8`), `lagrailla_cart`, eventos `grailla:cart-*`, `scripts/cargar-historico-compras.ts`. Nota: `lagrailla_cookie_consent` y `lagrailla_cart` son visibles en devtools del cliente (BAJO, ya en el informe previo).

**Rutas huérfanas/404:** los 19 `app/admin/*` tienen enlace en el menú (sin huérfanas). `OWNER_ONLY` incluye `/admin/roles` (`lib/modules/access.ts`) y esa página no existe (inocuo: los roles viven en el diálogo de Usuarios). Los selectores de temporada de Eventos/Productos/Pedidos fallan **en silencio** para roles que no tienen Contabilidad aunque el cliente sí (p. ej. «Gestor de entradas» no puede vincular temporada: la API da 403 por `pathAllowedForModules`).
**Escenario.** Demo a una sala de teatro o a una academia: el menú dice «Caseta», la primera temporada se llama «Feria de Septiembre», el desplegable de categorías es de bebidas.
**Solución (S–M).** (1) Renombrar grupo a «Compras y caja» o «Contabilidad» y retirar «caseta» de descripciones (S); (2) nombre de temporada por defecto = «Temporada {año}» (S); (3) categorías de gasto/ingreso/artículo **configurables por cliente** (`AppConfig` JSON con dueño `contabilidad`, valores por defecto neutros: «Compras», «Personal», «Alquiler», «Suministros», «Marketing», «Otros»; el legacy conserva su lista) y el prompt de IA parametrizado con esa lista (M); (4) confirmación de tienda sin copy de marca: usar `home_*`/config del cliente o neutro (S).
**Confianza.** VERIFICADO.

---

### CO-05 — No hay exportación contable normalizada (gestoría) y los CSV existentes no son aptos para Excel/ERP en España — **P1**
**Problema.** (a) Solo hay Excel/PDF de **gastos por temporada** completa, sin rango de fechas (los impuestos son trimestrales), sin NIF, sin cuota de IVA como columna, y la fecha se escribe como **texto** (`toLocaleDateString('es-ES')`), no como fecha Excel. (b) No hay export de **ingresos** (caja), de **ventas de tienda** ni de **ventas con IVA**. (c) El único CSV (`/api/admin/export`) usa **coma** como separador y **punto** decimal: abierto en Excel con configuración regional española se cae en una sola columna y los decimales se interpretan mal; la fecha es ISO en **UTC**; **trunca en silencio a 5000 pedidos/10000 entradas** sin avisar; vive bajo el módulo Entradas, así que el rol «Contable» no lo ve.
**Evidencia.** `lib/gastos/gastos-excel.ts:18-29,41` (columnas, fecha texto); `lib/gastos/gastos-data.ts` (sin filtros); `app/api/admin/export/route.ts:24,65,87-96,113` (separador `,`, `toFixed(2)` con punto, `take: 5000/10000`, `createdAt.toISOString()`); `lib/modules/registry.ts` (`/api/admin/export` → entradas); grep `csv` en `app lib`: solo ese fichero. Además el escudo anti-fórmula antepone `'` a todo valor que empiece por `-`: cuando existan importes negativos (reembolsos) el CSV los corromperá (`'-12.00`).
**Escenario.** La gestoría pide «ventas y gastos del 3T con base, tipo y cuota y NIF de proveedores». El cliente baja un Excel de toda la temporada, lo filtra a mano, no hay cuota ni NIF, y el CSV de ventas se abre en una columna.
**Impacto.** Fricción en la semana 1 con cualquier cliente con gestoría; soporte manual; riesgo de datos truncados sin aviso.
**Solución (M).** Nuevo endpoint `/api/admin/contabilidad/export?from&to&type=gastos|ingresos|ventas&format=csv|xlsx` con: rango por fecha (Madrid), CSV `;` + coma decimal + UTF-8 BOM (opción de «formato internacional»), columnas `fecha,serie/num,tercero,NIF,concepto,base,tipo,cuota,total,estado,forma_pago`, importes numéricos (no texto) en xlsx, paginación por cursor + `ReadableStream` (sin `take` silencioso; si hay límite, devolver 413 con mensaje), y export por tienda. Plantillas de columnas para A3/Holded/Contaplus/Sage como presets (S cada una; no certifiqué el formato exacto de cada ERP: **HIPÓTESIS** que bastan CSV/XLSX con esas columnas básicas, a validar con la gestoría real).
**Confianza.** VERIFICADO (estado actual). Formatos de ERP: HIPÓTESIS.

---

### CO-06 — Redondeo de importes en venta: la comisión no se redondea y el cobro de pasarela puede diferir 1 céntimo de lo guardado — **P1**
**Problema.** `calculateCommission` devuelve `subtotal * pct/100` sin redondear; el total (float) se (a) envía a Stripe con `Math.round(x*100)` (b) a SumUp **crudo** (`amount: params.amount`) y (c) se guarda en `Decimal(10,2)` (redondeo de Postgres). Dos redondeos distintos sobre el mismo float pueden dar céntimos distintos.
**Evidencia.** `lib/pricing.ts:6-8`; `app/api/orders/route.ts:185-189,228-229,342`; `lib/payment-adapter.ts:226` (`Math.round(params.amount * 100)`), `:357` (`amount: params.amount` a SumUp); `lib/reconciliation/shared.ts:23-25` (tolerancia `< 0.01`); el test `tests/lib/pricing.test.ts` solo comprueba `toBeCloseTo` (no impone céntimos). Simulación `node` (sin repo): con comisión **1,5 %** y 2 entradas de 16,50 € (33,00 €), el total es 33,495: Stripe cobraría 33,49 y Postgres guardaría 33,50 (24 de ~1.360 combinaciones probadas con 9 porcentajes fraccionarios dieron 1 céntimo de diferencia; con porcentajes enteros no apareció ninguno).
**Escenario.** Cliente con comisión 1,5 % o 2,5 %: algunos pedidos quedan 1 cent distintos entre pasarela y BD. Cada discrepancia es un falso positivo en cualquier conciliación (CO-07). Si SumUp rechaza importes con 3 decimales (**HIPÓTESIS**, no probado) el checkout fallaría en esos importes.
**Impacto.** Conciliación mensual con ruido; potencial fallo de cobro en SumUp.
**Solución (S).** Redondear a céntimos **una vez**, en un único punto, antes de crear el pedido (`round2` en comisión y total) y enviar/guardar el mismo valor; guardar importes en céntimos enteros (`amountMinor`) al hablar con pasarelas; añadir tests con porcentajes fraccionarios. Verificar con SumUp sandbox.
**Confianza.** Mecanismo VERIFICADO; efecto exacto PROBABLE (Postgres) / HIPÓTESIS (SumUp).

---

### CO-07 — Sin conciliación pasarela↔pedidos, sin comisiones de pasarela ni liquidaciones (payouts) — **P1**
**Problema.** No se guarda lo que cobra la pasarela (comisión de Stripe/SumUp), ni el neto liquidado, ni las fechas de liquidación; no se compara un extracto con pedidos. La «comisión» del `Order` es el **recargo al comprador** (`commission_percentage`), no el coste de pasarela, y en estadísticas «neto = total − comisión» (`app/api/admin/stats/route.ts:95-96`) se puede leer como si fuese coste. La conciliación del efectivo de taquilla solo cubre **efectivo** vs concepto de caja «Entradas»; **taquilla con tarjeta (datáfono) no se concilia**.
**Evidencia.** grep `payout|balance_transaction|application_fee|fee\b|liquidaci` en `app lib` = 0. `schema.prisma:254-293` sin campos de coste/neto. `lib/ventas-por-dia.ts:123-127` (solo `taquillaEfectivo`).
**Escenario.** Stripe liquida 10.000 € el día X menos 1,5 % + 0,25 €/tx; el ingreso bancario no coincide con ninguna cifra de la plataforma. La gestoría pregunta por el gasto «comisión de pasarela» y no existe.
**Solución (M–L).** Guardar en `Order`/`ShopOrder` el `balance_transaction` (fee, neto, fecha de disponibilidad) al completar; importar liquidaciones (Stripe `payouts` + `balance_transactions`) por cron en tabla `Payout`; informe «cobrado − comisión pasarela − reembolsos = neto liquidado» y registrar la comisión como gasto automático (categoría «Comisiones de pasarela») para el P&L (CO-03). Taquilla tarjeta: concepto de caja propio para cuadrar con el cierre del TPV.
**Esfuerzo.** M (campos+informe) / L (import de payouts, SumUp).
**Confianza.** VERIFICADO (ausencia). Impacto: PROBABLE.

---

### CO-08 — Cuadre de caja nocturna: día natural (Madrid) para ventas, día UTC para caja manual — **P1**
**Problema.** Las ventas se agrupan por día natural de Madrid, la caja manual por día UTC de su fecha (`2026-10-31T00:00Z`). Para un local nocturno que vende de 22:00 a 04:00, el efectivo de «la noche del sábado» se reparte entre sábado y domingo en el sistema, mientras la caja se anota en **un** día. `diferenciaCaja` sale descuadrada dos días seguidos **todas las noches** pasada la medianoche. Además la fecha por defecto del formulario es `new Date().toISOString().slice(0,10)` (UTC): entre 00:00 y 02:00 (verano) de Madrid propone el día anterior.
**Evidencia.** `lib/ventas-por-dia.ts:98-110` (`madridDayKey(o.createdAt)` vs `i.fecha.toISOString().slice(0,10)`); `ingreso-dialog.tsx:26`; `gasto-dialog.tsx:34`; `export/route.ts:87` (ISO UTC).
**Escenario.** Sábado 31/10: taquilla vende 600 € en efectivo (400 € antes de medianoche, 200 € después). El sistema muestra 400 € el sábado y 200 € el domingo; la caja manual «Entradas» del sábado es 600 €: diferencia +200 el sábado y −200 el domingo (si se registra otro día). El gerente pierde confianza en la herramienta de cuadre, que es de lo mejor del módulo.
**Solución (M).** Concepto de **jornada de negocio**: por evento (fecha del evento) o corte configurable (p. ej. 06:00 Madrid) aplicado a ventas y caja; `Ingreso` con `fecha` + `jornada` opcional o vínculo `eventId`; fecha por defecto en hora de Madrid. Test con ventas de 23:30 y 00:30.
**Confianza.** VERIFICADO (lectura de código); escenario PROBABLE para locales nocturnos.

---

### CO-09 — Temporada «CERRADA» no existe en la práctica; borrado duro y sin trazabilidad de cambios — **P1**
**Problema.** (a) Ninguna pantalla pone `CERRADA` (solo **archivar**, que es cosmético) y los handlers no comprueban `status` ni `archivado`: se puede crear, editar y borrar gastos/ingresos/pedidos de una temporada «cerrada». (b) `DELETE` de gasto/ingreso es borrado **duro** sin registro; solo se guarda `createdById` al crear, no quién editó ni qué valor tenía antes. (c) Un rol «Contable» tiene CRUD completo (no hay «solo lectura»).
**Evidencia.** grep `CERRADA` en `app lib components`: solo `temporada-selector.tsx:137` (mostrar etiqueta) y `compras/temporadas/[id]/route.ts:16,36` (se admite en PATCH, sin UI); `gastos/route.ts:57-72` y `ingresos/route.ts:45-54` sin comprobación de estado; `gastos/[id]/route.ts:66-75` y `ingresos/[id]/route.ts:41-50` `DELETE` duro; `schema.prisma:910-933` solo `createdById`, sin `updatedById`; grep `AuditLog|audit` en `schema.prisma`: 0 modelos de auditoría; `lib/modules/access.ts:20` rol «Contable» = `['contabilidad']`.
**Escenario.** Tras presentar el IVA del trimestre, alguien (o un contable externo) borra una factura de proveedor o cambia un importe; nadie sabe quién ni cuándo, y las cifras presentadas dejan de coincidir con el sistema. Con retención legal de libros/facturas (varios años; validar plazo con gestoría) el borrado duro es además un riesgo.
**Solución (M).** (1) Acción «Cerrar temporada» con confirmación + guardia en servicio (rechaza escrituras con 423 salvo reapertura con permiso del propietario) y fecha de cierre; (2) `AuditLog` genérico (entidad, id, acción, usuario, diff antes/después, fecha, IP) escrito en los handlers de gastos/ingresos/pedidos/temporadas; (3) anulación lógica (`voidedAt`, `voidedById`, motivo) en lugar de `DELETE`; (4) rol «Contable (solo lectura)» y permiso aparte de borrado/cierre.
**Confianza.** VERIFICADO.
**Validar con gestoría/abogado:** plazos de conservación de libros y justificantes y qué exige el cliente (Código de Comercio / normativa tributaria).

---

### CO-10 — Modelo de gasto/proveedor incompleto para una gestoría (NIF, retención, deducibilidad, documento adjunto, pago) — **P1**
**Problema.** `Proveedor` no tiene NIF/CIF, dirección ni IBAN; `Gasto` no tiene retención (IRPF), recargo de equivalencia, indicador de IVA deducible/no deducible, forma de pago/estado pagado, ni archivo adjunto de la factura; un único `ivaPercent` por gasto (una factura con 10 % y 21 % se registra como **media ponderada** `ivaEfectivo`, lo que da cuota correcta pero un tipo ficticio para libros de IVA). La UI de gasto-desde-pedido deja `numDocumento` como placeholder «25/008671».
**Evidencia.** `schema.prisma:776-791` (Proveedor), `:910-933` (Gasto); `lib/gasto-calc.ts:11-20` (`ivaEfectivo`); `gasto-desde-pedido-dialog.tsx:40-42`.
**Escenario.** La gestoría necesita el modelo 347 (operaciones con terceros que superan el umbral) y el libro de facturas recibidas con NIF y desglose por tipo: no se puede producir sin recopilar NIF a mano.
**Solución (M).** Añadir `Proveedor.nif/direccion/iban`, `Gasto.formaPago/pagado/fechaPago/deducible/retencionPercent`, y `GastoLinea` (base+tipo por línea) para facturas multi-IVA; adjuntar PDF/foto a Blob del cliente (con la misma limpieza `blob-cleanup`); validar formato de NIF/CIF/NIE.
**Confianza.** VERIFICADO.

---

### CO-11 — IVA 0 % (exento) imposible en artículos y tipos solo «21 por defecto» — **P1**
**Problema.** Al guardar un artículo `Number(form.ivaPercent) || 21` convierte **0 en 21**: no se puede registrar un artículo exento/0 %. Además todo el sistema asume 21 por defecto (`schema.prisma:799`, schema Zod `default(21)` en `gastos/route.ts:17`, formularios) y no hay concepto de recargo, IGIC (Canarias) o IVA no aplicable.
**Evidencia.** `app/admin/compras/_components/tab-articulos.tsx:112`; `gasto-dialog.tsx:152` (el diálogo de gasto sí acepta 0 con `|| 0`, el de artículo no).
**Escenario.** Un cliente que compra a proveedor intracomunitario o artículo exento ve que el sistema le sube silenciosamente el precio un 21 %; el pedido/gasto generado desde él sale mal.
**Solución (S).** Usar `Number.isNaN` y no `||`; selector de tipos (0/4/10/21 + exento) con tipos configurables por cliente (para futura multi-jurisdicción); validar rango `0..100` también en el API de artículos/gastos.
**Confianza.** VERIFICADO.

---

### CO-12 — Compras diseñado solo para bebidas de una caseta (dominio fijo) — **P1**
**Problema.** Aparte de las etiquetas de CO-04, la **IA de importación** y las categorías son bebidas y no configurables; `unidadesPorCaja`, «Formato: Lata 33cl», «Caja 24 uds» son vocabulario de barra; el consumo histórico solo se carga con un script (`scripts/cargar-historico-compras.ts`, grep: no hay UI) así que el «consumo de referencia» del planificador está vacío para cualquier cliente nuevo; la «temporada anterior» se elige por `anio < anio` (`lib/compras/planificador-data.ts:39-42`, `gastos/resumen/route.ts:28-31`), por lo que dos temporadas el mismo año (p. ej. Feria y Navidad) se comparan mal.
**Impacto.** Cliente no-bar: el módulo «Compras» parece roto o irrelevante; el planificador no aporta valor sin histórico.
**Solución (M).** Categorías y plantillas de artículo por cliente; importador de consumo (CSV/Excel) en UI; «temporada anterior» = la inmediatamente anterior por `fechaInicio` (o elegible); texto del prompt de IA parametrizado.
**Confianza.** VERIFICADO.

---

### CO-13 — `Ticket` sin precio ni IVA propios: imposible reembolso parcial/por línea, ingresos por tipo e IVA por tipo exactos — **P2**
**Problema.** La compra se guarda solo como `Order.totalAmount` + `Ticket` sin precio; `TicketType.price` es **editable tras vender** (`ticket-types/[id]/route.ts:13,34`, solo se bloquea el borrado). Cualquier informe «ingresos por tipo» o reembolso de una entrada concreta usa el precio actual, no el pagado (la tienda sí tiene `ShopOrderItem.unitPrice`).
**Solución (M).** `unitPrice`, `taxRate`, `taxAmount` en `Ticket` (o `OrderLine`) como snapshot al crear el pedido; migración aditiva con backfill por `ticketType.price` (aprox.) marcando los antiguos como «estimado».
**Confianza.** VERIFICADO (esquema y rutas).

---

### CO-14 — Validación débil de entradas y errores confusos en la API de contabilidad — **P2**
**Problema.** `ivaPercent`, `importeSinIva`, `importe` sin rango (`z.coerce.number()` sin `min/max`); una fecha inválida produce `Invalid Date` → error de Prisma → 500; temporada/proveedor inexistente → `P2003` que `handleApiError` traduce a «No se puede **eliminar**…» (409) incluso en un POST de creación; un importe grande desborda `Decimal(10,2)` → 500; `importe: 0` aceptado; la UI usa `Number(x) || 0` y puede guardar 0 en silencio si se teclea texto.
**Evidencia.** `gastos/route.ts:10-22`, `gastos/[id]/route.ts:11-21`, `ingresos/route.ts:10-16`, `lib/api-error.ts:18-23`; `gasto-dialog.tsx:81-82`, `ingreso-dialog.tsx:63`.
**Solución (S).** `zod`: `z.number().finite().min().max()`, fechas `z.coerce.date()`, comprobar existencia de temporada/proveedor/pedido con 404/422 explícitos, mensaje de FK específico por contexto, rechazar 0 salvo que se justifique.
**Confianza.** VERIFICADO.

---

### CO-15 — Falta un test que blinde «nunca enviar a proveedores» — **P2**
**Problema.** La regla del dueño se cumple hoy (VERIFICADO en la tabla de §0) pero depende de que nadie añada un `sendMail`/`fetch` en `lib/compras`, `app/api/admin/compras` o en el flujo de pedidos. El campo `Proveedor.email` existe (`schema.prisma:~781`) y la tentación de «enviar» es alta.
**Solución (S).** Test estático (como el de rutas sin dueño): ningún fichero bajo `app/api/admin/compras/**` ni `lib/compras/**` puede importar `@/lib/mailer`, `nodemailer` ni construir `wa.me`/`mailto:` para proveedores; y un test de handler que verifique `sendMail` sin llamadas al avanzar `BORRADOR→ENVIADO`. (Ya hay `tests/api/compras-pedidos.test.ts`.)
**Confianza.** VERIFICADO (estado actual); la falta de test, por grep en `tests/`.

---

### CO-16 — Contable y roles restringidos: pantallas con ceros engañosos y sin acceso a ventas — **P2**
**Problema.** El rol «Contable» (solo `contabilidad`) no puede llamar a `/api/admin/stats`, `/api/admin/events` ni `/api/admin/export` (módulo Entradas). `AdminDashboard` hace `setStats(data)` con el JSON de error y pinta «Ingresos 0,00 €, 0 entradas…» como si fueran datos; `EventosEnlazados` muestra «0 eventos enlazados» ante un 403. El Contable tampoco puede ver ni exportar ventas, que es justo lo que necesita.
**Evidencia.** `admin-dashboard.tsx:56-60` (`stats?.totalRevenue ?? 0`), `eventos-enlazados.tsx:17-22`, `lib/modules/access.ts:20`.
**Solución (S–M).** Tratar `!res.ok` como «sin permiso» y ocultar la sección; dar al rol Contable una vista **Ventas (solo lectura)** y el export de CO-05 bajo `contabilidad`; dashboard propio para Contable.
**Confianza.** VERIFICADO.

---

### CO-17 — Exportaciones y listados sin paginación (riesgo de timeouts serverless) — **P2**
**Problema.** `GET /api/admin/gastos`, `/ingresos`, `/compras/pedidos` devuelven todo; los exports de gastos/pedidos construyen ExcelJS/pdf-lib en memoria sin streaming; no hay `maxDuration` en ninguna ruta de contabilidad (solo sponsors/orders). Con miles de gastos o líneas, el export puede superar el límite de la función y devolver 504 sin mensaje útil. `/api/admin/export` trunca (CO-05).
**Evidencia.** `gastos/route.ts:35-43`; grep `maxDuration` en `app/api`: solo 3 rutas ajenas.
**Impacto.** Hoy moderado (un cliente maneja cientos de filas por temporada); crece con clientes grandes.
**Solución (S).** Paginación/cursor en listados; `export const maxDuration`; export en segundo plano para >N filas (cola + enlace por email) o streaming de CSV.
**Confianza.** PROBABLE (volumen aún no medido).

---

### CO-18 — IVA y divisas fijados: «EUR» y 21 % por todas partes — **P2**
**Problema.** `currency: 'EUR'` fijo al crear el cobro (`app/api/orders/route.ts:343`), `paymentMatchesOrder` solo admite EUR (`shared.ts:25`), formatos `€` en Excel/PDF; sin multi-moneda ni multi-jurisdicción. Para clientes españoles es correcto; no sirve para otros mercados UE (IVA local, OSS) ni no-euro.
**Solución (L, solo bajo demanda).** `Brand`/config con moneda y país del cliente; tabla de tipos por país; OSS solo para tienda con envíos intracomunitarios (a validar con gestoría).
**Confianza.** VERIFICADO.

---

### CO-19 — Cambio de IVA entre temporadas: el planificador histórico usa el IVA actual del artículo — **P2**
**Problema.** Pedidos y gastos tienen snapshot, pero `getPlanificadorData` recalcula con `articulo.ivaPercent` actual y con el precio actual del proveedor; consultar un planificador de una temporada pasada muestra costes de hoy. Si el tipo de IVA de un artículo cambia por ley (ha ocurrido con alimentos), el histórico de **plan** cambia.
**Evidencia.** `lib/compras/planificador-data.ts:67,103`.
**Solución (S–M).** Congelar el plan al cerrar la temporada (snapshot de precios/IVA) o mostrar el pedido generado como fuente de verdad cuando existe.
**Confianza.** VERIFICADO.

---

### CO-20 — RGPD y retención: sin política ni herramientas sobre datos de compradores y contables — **P2 (legal)**
**Problema.** No hay anonimización/borrado por interesado, ni purga de pedidos antiguos, ni política de retención diferenciada (datos del comprador vs registros contables obligatorios). `Order` guarda nombre, apellidos y email indefinidamente; los gastos se pueden borrar de forma dura (CO-09). El texto legal por defecto es genérico (`app/(public)/legal/privacidad/page.tsx`).
**Evidencia.** grep `retenci|anonim|purge|rgpd|gdpr|olvido` en `app lib`: solo consentimiento de formularios; la nota ya estaba en el informe previo para sponsors y tienda.
**Solución (M).** Procedimiento «anonimizar comprador» (mantiene importes/fechas para contabilidad, borra datos personales tras N años), registro de actividades de tratamiento y plazo configurable; DPA con la lista de subencargados (Blob, pasarela, Abacus AI; `extraer-imagen` envía una URL arbitraria a un tercero, CO-21).
**Validar con abogado:** plazos y base jurídica de retención; contenido del DPA.
**Confianza.** VERIFICADO (ausencia); criterio legal: no asesoramiento.

---

### CO-21 — `extraer-imagen` envía una URL arbitraria a un tercero — **P2 (confirma lo ya señalado)**
**Evidencia.** `app/api/admin/compras/articulos/extraer-imagen/route.ts:10` (`z.string().url()` sin restringir al Blob del cliente) → `provider.extractArticulosFromImage({ imageUrl })`.
**Solución (S).** Aceptar solo URLs de Blob del prefijo del cliente (`lib/blob-url.ts` ya tiene utilidades) y limitar tamaño/tipo.
**Confianza.** VERIFICADO.

---

### CO-22 — Dashboard para clientes sin Entradas y planificador sin entrada en la home — **P2**
**Problema.** Un cliente solo-Contabilidad aterriza en `CoreDashboard`, sin resumen ni acceso directo a Compras/Gastos/Ingresos (solo menú lateral), y sin el widget de margen (que vive en `AdminDashboard`).
**Evidencia.** `app/admin/page.tsx:25-33`, `core-dashboard.tsx:20-25`.
**Solución (S).** Tarjetas de acceso y el P&L de CO-03 en un `ContabilidadDashboard` embebido cuando el módulo está activo (patrón ya usado con `ShopDashboard embedded`).
**Confianza.** VERIFICADO.

---

## 3. Casos límite pedidos (resumen contrastado)

| Caso | Estado | Ref. |
|---|---|---|
| Float en dinero | **No** en BD (Decimal) ni en lecturas (`lib/prisma.ts`). Pero la **aritmética de aplicación** sigue en `number` y la comisión no se redondea (CO-06). `cantidad`/consumos son `Float` (aceptable: son unidades) | `schema.prisma:838,858,896` |
| Importes negativos / cero | Gastos negativos permitidos (abonos); ingresos negativos permitidos sin tipo «corrección»; sin validación de rango (CO-14); `ivaEfectivo` ignora líneas de base ≤0 | `gasto-calc.ts:11-20` |
| División de pagos | No existe pago dividido (efectivo+tarjeta en un pedido): cada pedido tiene un único `paymentMethod`. Taquilla con parte en efectivo y parte en tarjeta obliga a dos pedidos | `schema.prisma:40-44,254-293` |
| Reembolso parcial → ingresos | No existe; el reembolso total sale de ingresos (solo suma `COMPLETED`) sin fecha de movimiento (CO-02) | `gastos/resumen/route.ts:61-66` |
| Cobrado y luego anulado | Efectivo/mock: `CANCELLED` sin movimiento de caja; tarjeta: obliga a «Reembolsar» (bien, `entradas.ts:127-138`) | CO-02 |
| Cambio de IVA entre temporadas | Pedidos y gastos con snapshot ✓; planificador no (CO-19) | |
| Exportación grande | CSV trunca 5000/10000 en silencio; Excel/PDF sin streaming; sin `maxDuration` (CO-05, CO-17) | |
| Zona horaria | Ventas: Madrid ✓. Caja/gastos: fecha como «medianoche UTC»; defaults en UTC; export CSV en UTC (CO-08) | |
| Divisas | Solo EUR (CO-18) | |
| Pedido borrador vs gasto | `Gasto.pedidoId @unique`: un segundo registro del mismo pedido da `P2002` → 500 genérico (la UI deshabilita el botón si ya hay gasto, pero la API no lo comunica bien) | `schema.prisma:917`; `handleApiError` sin `P2002` |

## 4. Aislamiento (punto 5) — conclusión
Las rutas de contabilidad no son accesibles con el módulo apagado (404 por `ownerOfPath`/`ownerEnabled`), ni con licencia vencida en panel (`PANEL_BLOCKED` ⇒ 402), ni por un rol sin el módulo (403 en middleware; el handler recibe sesión recalculada). Los datos de Contabilidad de un cliente nunca se mezclan con otro (BD propia por tenant; `requireTenant()` en `lib/prisma.ts`). **No he encontrado fuga de aislamiento**. Matices: (1) `ventas-por-dia` y `gastos/resumen` leen entre módulos con guardia explícita ✓; (2) el handler no vuelve a comprobar el módulo (confía en el middleware): coherente con el diseño documentado, pero una ruta nueva que no se registre se cierra por default-deny (test enumera rutas) ✓.

## 5. Plan sugerido (orden por riesgo/retorno)
1. **Antes de la primera venta (~3–4 días):** CO-04 (S, etiquetas/seed/recibo de tienda), CO-11 (S, IVA 0), CO-01 fase 1 (S–M, datos fiscales + rótulo «justificante»), CO-06 (S), CO-15 (S, test), CO-14 (S).
2. **Semana 1–2 de clientes reales:** CO-02 (M, webhook de reembolso+ledger), CO-09 (M, cierre+auditoría+anulación), CO-05 (M, export normalizado con rango), CO-08 (M, jornada), CO-10 (M, NIF y gastos multi-IVA).
3. **Roadmap:** CO-03/22 (P&L único), CO-07 (payouts y comisiones), CO-01 fase 2–3 (IVA por producto, integración de facturación), CO-12/13/16/17/19/20.

## 6. Qué debería validar una gestoría/abogado antes de prometer nada
- Tipo de IVA de cada entrada/producto y si el justificante de compra vale como factura simplificada (contenido exacto, límites).
- Obligación y calendario vigente de Verifactu/TicketBAI para el software de cada cliente (y si la plataforma queda como «sistema informático de facturación»).
- Tratamiento fiscal del recargo (comisión) cobrado al comprador y de las comisiones de pasarela.
- Rectificativas en reembolsos parciales y cancelaciones de evento.
- Plazos de conservación de libros/justificantes y su convivencia con RGPD (CO-09, CO-20).
- IVA de operaciones de tienda con envío a otros Estados UE (OSS).
- Formato real de importación de A3/Holded/Contaplus/Sage que use cada gestoría (CO-05).
