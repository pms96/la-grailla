# Auditoría del módulo VENTA DE ENTRADAS — La Grailla

Fecha: 2026-10-27. Solo lectura (código y docs; no se ejecutó nada contra BD, red ni servidores; únicamente dos cálculos aritméticos con `node -e` para EN-16).
Leído antes: `docs/platform/revision-modulos-y-plantillas.md`, `doc/audit-report.md` (2026-09-04), `docs/platform/m4/m5/m6/m8/m9`, `lib/modules/registry.ts`, tests de `tests/` y `__tests__/audit/`.

Escala de confianza: **VERIFICADO** = leído en el código y la cadena de llamadas está completa; **PROBABLE** = el código lo permite pero depende de un comportamiento externo (Stripe, SumUp, Vercel, navegador); **HIPÓTESIS** = no confirmable solo con lectura.

> Qué NO se pudo comprobar: ningún pago real (Stripe/SumUp), ningún comportamiento de Vercel/Neon bajo carga, ningún render. Los números de capacidad son estimaciones razonadas, no mediciones.

---

## 0. Resumen ejecutivo

| ID | Prio | Hallazgo (una línea) | Confianza |
|---|---|---|---|
| EN-01 | P0 | Un pedido sin pagar retiene aforo **24 h** (sesión Stripe por defecto; SumUp sin caducidad), no se libera al volver de la pasarela y cuenta para el tope por email; un script puede agotar un evento con carritos impagados | VERIFICADO |
| EN-02 | P0 | La hora del evento que teclea el admin se guarda como UTC y la web/entradas/Wallet la muestran en Madrid: un evento de las 23:30 sale como «00:30 del día siguiente» | VERIFICADO (supone servidor en UTC, como dice el propio código) |
| EN-03 | P0 | La allowlist del plan NO cubre la **pantalla** del escáner (`/acceso`) ni `/api/events` que la alimenta: en fase BLOCKED, con el módulo apagado o con el cliente suspendido, la puerta se queda sin app aunque `/api/scan` siga vivo | VERIFICADO |
| EN-04 | P0 | Pago confirmado sobre un pedido ya liberado/anulado: cobrado sin entrada, sin reembolso automático y sin aviso al comprador (solo email al operador, si hay `admin_email`) | VERIFICADO (el caso SumUp, PROBABLE) |
| EN-05 | P1 | La página de confirmación dice «Compra confirmada» y muestra los QR de un pedido CANCELLED/REFUNDED; pdf-html y Wallet también emiten QR de pedidos anulados | VERIFICADO |
| EN-06 | P1 | Sin defensa anti-reventa/bots: sin tope por pedido en el servidor (el 10 es solo de la UI), sin captcha, límite solo por email (alias `+x`), `maxTicketsPerEmail` vacío por defecto | VERIFICADO |
| EN-07 | P1 | Reintento idempotente devuelve `checkoutUrl: null`: el comprador queda en «Confirmando tu pago…» sin poder pagar; al volver desde la pasarela pierde su sitio en la cola | VERIFICADO / PROBABLE |
| EN-08 | P1 | Reembolso: estados «zombi» (REFUNDED con entradas VALID), cambios hechos en el panel de Stripe/contracargos no se sincronizan y quedan bloqueados | VERIFICADO |
| EN-09 | P1 | Evento cancelado / con cambio de fecha: ningún aviso, ningún reembolso masivo, la ficha sigue mostrando «Comprar» y el escáner admite entrada | VERIFICADO |
| EN-10 | P1 | Emails: duplicados por carrera webhook/confirmación/cliente, sin reintento automático si el SMTP falla, y el envío (PDF+SMTP) va dentro del webhook | VERIFICADO / PROBABLE |
| EN-11 | P1 | «Agotado», «Alta demanda» y «Sin plazas online» se calculan con `currentCount` (entradas escaneadas en puerta), no con vendidas: el listado y las 6 plantillas nunca marcan agotado antes del evento | VERIFICADO |
| EN-12 | P1 | Puerta: 429/401/500 del escáner se pintan como ❌ sin texto ni fondo; límite 120/min por IP compartida; sin offline; sin búsqueda por nombre/email ni check-in manual; «Hora de entrada» en UTC | VERIFICADO |
| EN-13 | P1 | `/api/scan` no mira `order.status` ni `event.status`/fecha: QR de pedido REFUNDED (zombi) o de evento cancelado entra | VERIFICADO |
| EN-14 | P1 | Sin recuperación de entradas por el comprador ni envío/asignación por entrada (todas llevan el nombre del comprador; un PDF con todos los QR) | VERIFICADO |
| EN-15 | P1 | El importe cobrado no se contrasta en el camino principal (webhook de Stripe) y, donde sí se contrasta, un redondeo de 1 céntimo con comisión ≠ 0 deja el pedido sin completar | VERIFICADO (aritmética) |
| EN-16 | P1 | SumUp (sin webhook): throughput del cron (50/pasada), entrega dependiente del regreso del comprador; reembolso reescrito pero sin prueba real | PROBABLE |
| EN-17 | P1 | Sala de espera en Postgres (ya conocido, sigue abierto): coste por sondeo y pérdida de turno al volver de la pasarela | VERIFICADO el coste; HIPÓTESIS la capacidad |
| EN-18 | P1 | Entradas de 0 € (o totales < 0,50 €) no se pueden vender online con Stripe (502) | PROBABLE |
| EN-19 | P1 | Checkout sin aceptación explícita de condiciones/privacidad/no-desistimiento; el aviso de edad no queda registrado | VERIFICADO |
| EN-20 | P2 | Estadísticas y exportaciones inconsistentes (vendidas incluye PENDING e invitaciones; ingresos sin reembolsos; UTC; truncado silencioso) | VERIFICADO |
| EN-21 | P2 | TAQUILLA/ADMIN: emisión gratis sin cupo ni auditoría, anular invitaciones con entradas USED, sin `isActive`/estado del evento en taquilla, emails `@lagrailla.local` fijos | VERIFICADO |
| EN-22 | P2 | Rendimiento/robustez: índices, `void checkCapacityAlerts` en serverless, `/api/orders` sin `maxDuration`, consultas a Stripe en cada sondeo de confirmación | PROBABLE / HIPÓTESIS |
| EN-23 | P2 | Gaps de mercado: sin ventana de venta por fecha, códigos promo, lista de espera de agotadas, reentrada, factura, Bizum, QR rotativo, Wallet actualizable | VERIFICADO (ausencia, con grep) |

---

## 1. Lo que ya está bien (breve, con evidencia)

- **Sin sobreventa entre compradores, online y taquilla.** Las tres vías que emiten entradas (`app/api/orders/route.ts:169`, `app/api/taquilla/sale/route.ts:91`, `app/api/invitations/route.ts:62`) toman el mismo `pg_advisory_xact_lock(hashtext(eventId))` y recuentan DENTRO del lock (`ticket.count` en `orders/route.ts:213-218`, comparado con `maxCapacity`, más `soldCount + qty > maxQuantity` por tipo en `:182`). Simulación mental pedida: (1) dos compras simultáneas por las 2 últimas entradas: A toma el lock, B espera; A hace commit antes de soltar el lock; en READ COMMITTED la primera consulta de B ya ve lo de A, y B recibe «Aforo completo» / «No hay suficientes entradas». (2) Online + taquilla: misma clave de lock, mismo resultado. El advisory lock es de transacción, así que funciona con pgbouncer. Quedan fuera del lock solo operaciones que liberan (decrementos atómicos).
- **Doble envío de creación de pedido:** `idempotencyKey` única en BD + `P2002` capturado (`orders/route.ts:80-91, 236-246, 297-316`); la clave se limpia al cancelar (`:379`, `reconciliation/entradas.ts:77`); la sesión de Stripe lleva `idempotencyKey: checkout_${orderId}` (`payment-adapter.ts:240`) y el reembolso `refund_${id}` (`entradas.ts:163`). La taquilla replica el patrón (`taquilla/sale/route.ts:50-66`).
- **Webhooks:** firma verificada sobre el cuerpo crudo (`payment-adapter.ts:152-169`); dedup `ProcessedWebhookEvent` marcada DESPUÉS de procesar (`webhook-handler.ts`, PAY-05 resuelto); `completeOrder`/`releaseExpiredOrder` son `updateMany` condicionados a `PENDING` (atómicos), así que webhook duplicado, fuera de orden (`expired` tras `completed`) o en carrera con el cron no reescriben nada. Test: `tests/api/webhooks-stripe.test.ts:117`.
- **Doble escaneo concurrente:** `updateMany where status VALID` + `count === 0 → DUPLICATE` (`scan/route.ts:127-148`) (SEC-03 resuelto).
- **Cancelar ≠ reembolsar:** un pedido COMPLETED con tarjeta real no se puede «cancelar» sin devolver el dinero (`entradas.ts:127-139`) (PAY-01 resuelto); el reembolso reclama el estado por compare-and-swap (`:152`) y se revierte si la pasarela falla (`:165-176`).
- **Limpieza si falla la pasarela al crear la sesión** (`orders/route.ts:360-387`) y la pasarela `mock` está bloqueada en producción (`payment-adapter.ts:548`).
- **Tipos desactivados / de otro evento** se rechazan en `orders` (`:143,181`) y de otro evento en taquilla (`taquilla/sale:97`).
- **Allowlist de licencia para lo ya pagado:** webhooks, crons, `/api/scan`, `/api/access/*`, lectura de pedido/PDF y reembolsos PATCH no se cortan (`registry.ts:143-156`, test `tests/tenant/gating.test.ts:127-148`).
- **Datos del comprador:** token HMAC por pedido/ticket, escapado HTML en emails y `pdf-html` (SEC-01 resuelto), IDOR de tienda resuelto, API pública de eventos sin campos internos (`lib/public-event.ts`).
- **Venta online cerrada** («solo taquilla») validada en servidor (`orders/route.ts:105`), evento terminado (inicio + 6 h, `lib/active-event.ts:70`) validado en servidor.
- **Accesibilidad móvil del checkout aceptable:** etiquetas, `aria-invalid`, `autoComplete`, `inputMode="email"`, barra fija con `safe-area-inset`, `role="status"` en confirmación (`buy-tickets-form.tsx`, `confirmation-client.tsx`). No se detectaron bloqueos.
- **Reconciliación:** cola justa por `reconcileCheckedAt` con sellado previo, 502 cuando una pasada entera falla (`cron/reconcile-payments/route.ts:31-51, 212-229`), disparo cada 5 min desde el panel (Vercel Pro) con latido externo (`m9-primer-despliegue.md`).

---

## 2. Hallazgos

### EN-01 · P0 · El aforo queda retenido 24 h por pedidos impagados (y se puede explotar)

**Problema.** El pedido se crea `PENDING` y sus entradas `PENDING` cuentan contra aforo, stock por tipo y tope por email desde el segundo cero. No existe un tiempo de retención corto: la sesión de Stripe se crea sin `expires_at` (caduca a las 24 h por defecto de Stripe), la de SumUp sin `valid_until`, y el cron solo libera por antigüedad a las 24 h (o antes si la pasarela dice `EXPIRED`). Volver desde la pasarela (`cancelUrl`) no libera nada.

**Evidencia.**
- `lib/payment-adapter.ts:219-241` (`checkout.sessions.create` sin `expires_at`); `:349-364` (SumUp sin `valid_until`).
- `app/api/orders/route.ts:213-218` (`issuedCount` = todo ticket no CANCELLED/REFUNDED, incluye PENDING); `:346-347` (`cancelUrl` = `/eventos/slug/comprar`, sin liberar).
- `app/api/cron/reconcile-payments/route.ts:25` (`MAX_AGE_MS = 24 * 60 * 60_000`), `:82-89`.
- `app/(public)/eventos/[slug]/comprar/_components/buy-tickets-form.tsx:113` y `orders/route.ts:40-47`: el máximo de 10 por tipo vive solo en la UI; el esquema del servidor es `z.number().int().positive()`.

**Escenario.** (1) Venta con 500 entradas, 1.000 personas. Un comprador abre Stripe, no le va la tarjeta y cierra: sus 4 entradas siguen retenidas 24 h. Si el evento tiene `maxTicketsPerEmail = 4` y vuelve a intentarlo, recibe «Este email ya ha comprado el máximo…» (cuenta PENDING). (2) Abuso: un script llama a `POST /api/orders` (10/min/IP por defecto, configurable) pidiendo 10 entradas por tipo, sin pagar: ~50 pedidos agotan 500 entradas en minutos desde una sola IP o pocas; el evento aparece «Aforo completo» durante 24 h aunque no se haya cobrado nada, y el organizador no puede distinguirlo de demanda real.

**Impacto.** Es el fallo que más duele en un evento con demanda: ventas perdidas, tickets de soporte («dice agotado y luego salen entradas»), sensación de manipulación. Bloquea la promesa comercial de «eventos con mucha demanda».

**Solución.** (a) Retención corta explícita: Stripe `expires_at = now + 30 min` (mínimo permitido) y SumUp `valid_until` equivalente; liberar por webhook `checkout.session.expired` (ya cableado) y, en el cron, liberar a los ~35 min tras `verifyPayment` (hoy 24 h) con constante configurable. (b) En `cancelUrl` apuntar a una ruta que reciba `orderId`+token y libere el pedido si la sesión no está pagada (o expirar la sesión de Stripe con `sessions.expire`). (c) Tope por pedido en el servidor (`maxTicketsPerOrder`, p.ej. 6-10) y tope de pedidos PENDING por IP/email. (d) Mostrar la cuenta atrás de la retención en la pasarela/confirmación. Ojo: acortar la retención aumenta la probabilidad de EN-04; resolverlos juntos.

**Esfuerzo.** M. **Confianza.** VERIFICADO (el valor por defecto de 24 h de Stripe es conocimiento externo; el código no fija ningún otro valor).

---

### EN-02 · P0 · La hora del evento se interpreta en UTC al guardar y se muestra en Madrid

**Problema.** El formulario de eventos envía `date` como `datetime-local` sin zona (`"2026-12-31T23:30"`); el servidor hace `new Date(body.date)`, que en Vercel (UTC, según el propio comentario de `lib/event-time.ts:1`) lo guarda como 23:30Z. La web pública, el email, el PDF y el pase de Apple Wallet formatean en `Europe/Madrid`, así que ven las 00:30/01:30 del día siguiente. Al editar, el formulario rehidrata con `toISOString().slice(0,16)` (UTC), así que el admin «ve» siempre lo que tecleó y el error es invisible para él.

**Evidencia.**
- `app/admin/eventos/_components/events-manager.tsx:112` (`new Date(event.date).toISOString().slice(0, 16)`), `:350` (`type="datetime-local"`), `:169-176` (payload con `date` crudo).
- `app/api/admin/events/route.ts:132`, `app/api/admin/events/[id]/route.ts:74` (`new Date(body.date)`).
- Visualización en Madrid: `app/(public)/eventos/[slug]/page.tsx:85`, `lib/tickets.ts:30-37`, `lib/ticket-pdf.ts:38-43`, `lib/wallet.ts:309-310` (el pase muestra además la HORA), JSON-LD con la fecha ISO.
- Inconsistencias adicionales: `app/api/tickets/[orderId]/pdf-html/route.ts:44-46` (`toLocaleDateString` sin `timeZone` → UTC) es el enlace «Ver e imprimir» del email y de la confirmación; `app/api/scan/route.ts:116,166` («Hora de entrada» en UTC en el servidor).
- El plan (`revision-modulos-y-plantillas.md:247`) corrigió el formateo público a Madrid pero no el sentido contrario (entrada del admin).

**Escenario.** Sala nocturna: el admin crea «Noche X, 23:30». La ficha, el email y el pase dicen «sábado 00:30/01:30» (día siguiente en verano, +2 h); la impresión (`pdf-html`) dice el día correcto; el portero ve «Hora de entrada: 21:35» cuando entró a las 23:35. El comprador duda del día, escribe a soporte o aparece el día equivocado.

**Impacto.** Fecha incorrecta en un documento de compra = incidente de soporte seguro en la primera venta de un evento de noche (cualquier inicio ≥ 22:00 en verano / ≥ 23:00 en invierno cambia el día), y riesgo de reclamación. Además `hasEventEnded` (inicio + 6 h) y «evento de hoy» se desplazan 1-2 h.

**Solución.** Un único módulo de zona (`lib/event-time.ts`) con `parseEventLocal("YYYY-MM-DDTHH:mm") → Date` interpretando Europe/Madrid y `formatEventLocal(Date) → input value`, usado en el formulario y en las dos rutas. Decisión de datos necesaria: los eventos existentes están guardados como «hora de pared en UTC»; hay que migrarlos (sumar el offset de cada fecha) o fijar un corte. Unificar `pdf-html` y los mensajes del escáner con `timeZone: EVENT_TIMEZONE`. Añadir test con el proceso en UTC y en Madrid (hoy el test del plan solo fija el formateo).

**Esfuerzo.** S-M (el código S; la migración de datos y la verificación con eventos reales M). **Confianza.** VERIFICADO; depende de que Vercel corra en UTC (confirmado por el comentario de `lib/event-time.ts`).

---

### EN-03 · P0 · La puerta se queda sin escáner en BLOCKED, con el módulo apagado o con el cliente suspendido

**Problema.** El plan y el registro dicen que «en la puerta de un evento hay que seguir validando entradas ya vendidas». La allowlist solo libera `/api/scan` y `/api/access/*` (APIs). La **página** `/acceso` y `GET /api/events?status=PUBLISHED` (de donde el escáner saca la lista de eventos, `access-client.tsx:76`) no están exentas, y el cliente suspendido corta todo salvo webhooks/crons/health.

**Evidencia.**
- `lib/modules/registry.ts:143-156` (`isLicenseExempt`: sin `/acceso`, sin `/api/events`).
- `lib/tenant/middleware.ts:71-76` (`BLOCKED` → `notice` 503 para páginas, 503 para API no exentas); `:134` (`ctx.status !== 'ACTIVE' && !isNeverBlockable(path)` → 503; `isNeverBlockable` no incluye scan, `:29-31`).
- `app/acceso/_components/access-client.tsx:76` (`fetch('/api/events?status=PUBLISHED')`).
- El test que blinda la allowlist (`tests/tenant/gating.test.ts:127-148`, `tests/lib/module-registry.test.ts:68-72`) prueba solo `/api/scan` y `/api/access/capacity`; ninguno prueba `/acceso`.
- Con el módulo `entradas` apagado: `ownerEnabled` falso para `/acceso` → 404; `/api/scan` sí pasa.
- En `PANEL_BLOCKED` la pestaña Invitaciones del escáner (`/api/invitations`, `/api/guest-lists`) cae en `isPanelPath` (`middleware.ts:48-58`) → 402, y el enlace «Modo noche» (`/admin/noche`) también.

**Escenario.** Un cliente deja de pagar; pasa a BLOCKED el sábado de su festival. El staff abre `/acceso`: página de aviso 503, ni siquiera cargan los eventos. `/api/scan` funcionaría, pero no hay UI que lo llame. 1.500 asistentes con QR pagado no pueden entrar, o el organizador entra «a mano»: reclamaciones y daño reputacional para La Grailla como proveedor. El mismo efecto si un operador pulsa «Suspender» por error.

**Impacto.** Contradice una garantía explícita del plan; es un fallo catastrófico y público, pero solo se manifiesta cuando se aplica la política de licencias, por eso es mejor cerrarlo antes de empezar a cobrar licencias.

**Solución.** Ampliar `isLicenseExempt` y `isNeverBlockable` con: `GET /acceso*`, `GET /api/events` y `GET /api/events/*` (solo lectura), `/api/admin/scans` GET y `/api/admin/noche` GET (opcional, solo lectura), y el login. Decidir y documentar la política para `suspended` (¿se corta la puerta?; recomendado: no, igual que webhooks). Añadir al test de allowlist `/acceso`, `/api/events` y «módulo entradas apagado + `/api/scan`». Con módulo apagado, `ownerEnabled` debe dar 404 a venta pero no a `/acceso` mientras haya entradas VALID del módulo.

**Esfuerzo.** S. **Confianza.** VERIFICADO.

---

### EN-04 · P0 · Pago confirmado sobre un pedido ya liberado/anulado: cobrado sin entrada

**Problema.** Si la pasarela confirma un cobro cuando el pedido ya no está `PENDING` (liberado por caducidad, cancelado), `completeOrder` no hace nada salvo mandar un email al operador. El dinero queda cobrado; las entradas ya se devolvieron al aforo (y pudieron venderse a otra persona). Nada reembolsa, nada avisa al comprador.

**Evidencia.** `lib/reconciliation/entradas.ts:22-41` (`!transitioned && order.status !== 'COMPLETED'` → `alertPaidButInactiveOrder`); `lib/reconciliation/shared.ts:50-65` (email solo si existe `admin_email`, `getOperatorEmail`; si no, solo `console.error`). Para SumUp: `payment-adapter.ts:349-364` no pone caducidad y el cron libera a las 24 h (`reconcile-payments/route.ts:145-165`); un checkout de SumUp sin `valid_until` no caduca (documentación de SumUp; PROBABLE). Tras la liberación el cron no vuelve a mirar el pedido (solo `status: 'PENDING'`).

**Escenario.** (SumUp) El comprador deja la pestaña de pago abierta, paga al día siguiente. El pedido ya es CANCELLED; el cobro entra; el comprador ve «Compra confirmada» (EN-05) y no recibe email; el operador (si tiene correo configurado) recibe un aviso que nadie lee a tiempo. En el día del evento, el comprador llega sin entrada. Stripe: con sesión de 24 h y cron a 24 h el hueco es de segundos, pero al aplicar EN-01 (30 min) deja de serlo si Stripe no expira la sesión a la vez; también ocurre con pedidos anulados a mano mientras la sesión sigue abierta.

**Impacto.** Cobro sin servicio = contracargo, reclamación al organizador, posible incumplimiento de consumo. Es el peor resultado posible de un pago.

**Solución.** Política de «pago tardío» determinista dentro de `completeOrder`: si el pedido está `CANCELLED`, reintentar reservar (mismo lock y comprobación de aforo) y completar si hay hueco; si no hay hueco, **reembolsar automáticamente** (clave de idempotencia) y mandar email al comprador explicando el motivo. Registrar la incidencia (columna/tabla de auditoría) y mostrar un contador «pagos sin entrada» en el panel. Igualar la caducidad de la pasarela y la de la BD (`expires_at`/`valid_until`) para que el caso sea imposible por construcción.

**Esfuerzo.** M. **Confianza.** VERIFICADO el comportamiento del código; el caso SumUp, PROBABLE.

---

### EN-05 · P1 · «Compra confirmada» con QR de pedidos cancelados o reembolsados

**Problema.** La confirmación solo distingue `PENDING`; cualquier otro estado se pinta como compra exitosa y se renderizan los QR. Pasa también con el carrusel (`TicketCarousel`), «Total pagado» y el botón «Ver e imprimir». `GET /api/orders/[orderId]` devuelve el pedido sin mirar el estado. Los QR de `pdf-html` y los pases de Wallet tampoco comprueban el estado. Además el cliente llama a `send-tickets`, que devuelve `order_inactive` y se pinta «No hemos podido enviar el email».

**Evidencia.** `confirmation-client.tsx:55` (`isPending` es la única rama de estado), `:96-110` (autoenvío), `:223-300`; `app/api/tickets/[orderId]/pdf-html/route.ts:24-38` (sin comprobación de `order.status`); `app/api/wallet/apple/[ticketId]/route.ts:20-30` (sin comprobar `ticket.status`); `lib/tickets.ts:182-184` (`order_inactive`).

**Escenario.** El comprador vuelve a su enlace de confirmación tras un reembolso, o tras expirar la reserva (EN-01/04), y ve «Compra confirmada» y sus QR. Llega a la puerta con una entrada que el escáner rechaza como «Anulada/Reembolsada».

**Impacto.** Tickets de soporte y discusión en puerta; agrava EN-04.

**Solución.** Estados explícitos en la UI (`CANCELLED`: «La reserva caducó/fue anulada», `REFUNDED`: «Pedido reembolsado el dd/mm»); la API de pedido devuelve `status` y los QR solo si `VALID/USED`; `pdf-html` y Wallet rechazan tickets no activos (404/410 con mensaje).

**Esfuerzo.** S. **Confianza.** VERIFICADO.

---

### EN-06 · P1 · Sin defensa frente a bots/reventa y límites por persona débiles

**Problema.** (a) Tope por pedido solo en la UI (10 por tipo). (b) Sin captcha/Turnstile en `/api/orders` ni en la cola (`grep` de captcha/turnstile: sin resultados en `app/`, `lib/`, `components/`). (c) Límite por persona = por email, comparación case-insensitive pero sin normalizar `+alias` ni puntos de Gmail (`orders/route.ts:198-211`); `maxTicketsPerEmail` es `null` por defecto (`schema.prisma`, `events-manager.tsx:99`). (d) Límite por IP de 10 pedidos/min (`orders/route.ts:61-63`) pensado para wifi compartida, pero un script rota IPs. (e) La cola limita a 3 turnos vivos por IP (`queue/join/route.ts:23`), burlable igual.

**Escenario.** Concierto con demanda: un revendedor con 20 emails `x+1@gmail.com` y 3 IPs lleva 200 entradas sin pasar por la cola o con 60 turnos.

**Impacto.** Quejas de «agotado en 2 minutos», reventa a precio inflado; el organizador culpa a la plataforma.

**Solución.** Turnstile/hCaptcha (gratis) en `join` de la cola y en `POST /api/orders` cuando el evento tenga sala de espera; `maxTicketsPerOrder`; normalizar email (minúsculas, quitar `+alias`, puntos de Gmail) para el recuento; opción por evento de limitar por tarjeta/teléfono (con Stripe Radar); mostrar el límite en el formulario. Hasta tenerlo, documentar al cliente que debe poner `maxTicketsPerEmail` y activar la sala de espera.

**Esfuerzo.** M. **Confianza.** VERIFICADO.

---

### EN-07 · P1 · Reintento con la misma clave devuelve «éxito» sin enlace de pago; volver desde la pasarela pierde el turno

**Problema.** Cuando `POST /api/orders` reconoce la `idempotencyKey` de un pedido existente (respuesta perdida, formulario restaurado desde caché de «atrás»), responde `success: true, checkoutUrl: null`. El cliente redirige a `/confirmacion`, que muestra «Confirmando tu pago…» 45 s y después «La confirmación tarda más de lo normal». El comprador no paga nunca (no tiene URL) y el pedido retiene aforo (EN-01). Además, al volver desde Stripe por `cancelUrl`, la entrada de cola del comprador ya está `COMPLETED` (se marca al crear la sesión) y la sala lo reenvía al final de la cola.

**Evidencia.** `orders/route.ts:80-91` y `:303-315` (`checkoutUrl: null`); `buy-tickets-form.tsx:176-180` (`if (data?.checkoutUrl) … else router.push('/confirmacion')`) y `:119-123, 187-192` (la clave se conserva ante fallo de red); `orders/route.ts:322-325, 352` (`releaseQueueSlot` → `COMPLETED` al crear la sesión); `waiting-room-gate.tsx:127-138` (toast «Te llevamos de nuevo a la cola»).

**Escenario.** Móvil con cobertura mala: el POST se procesa pero la respuesta no llega; «Sin conexión, inténtalo otra vez»; segundo intento → confirmación eterna. O bien: el comprador cierra Stripe con la flecha de «atrás», vuelve a `/comprar` y vuelve a hacer cola con 3.000 personas por delante, mientras su primer pedido sigue reteniendo entradas.

**Impacto.** Compras perdidas justo en la franja de mayor demanda y tickets de soporte («no me deja pagar»).

**Solución.** Si el pedido existente está `PENDING` y tiene `paymentId`, devolver una URL de reanudación: Stripe `sessions.retrieve(id).url` si sigue `open` (o guardar `checkoutUrl` en el pedido); si no, liberar y crear de nuevo. No marcar la cola `COMPLETED` hasta el pago (o conservar el turno N minutos mientras haya un pedido PENDING). Combinar con la ruta de cancelación de EN-01.

**Esfuerzo.** M. **Confianza.** VERIFICADO (código); la restauración del formulario por bfcache es PROBABLE (depende del navegador).

---

### EN-08 · P1 · Reembolso: estados zombi y desincronía con la pasarela

**Problema.** (1) Orden de operaciones en `invalidateOrder`: marca el pedido `REFUNDED`, llama a la pasarela y por último, en otra transacción, anula las entradas y libera `soldCount`. Si el proceso muere o falla entre pasos (timeout de la función, error de BD), queda pedido `REFUNDED`, entradas `VALID` (el QR entra, EN-13) y stock sin liberar; ningún job lo repara. (2) Los eventos de Stripe `charge.refunded` y `charge.dispute.*` se ignoran (`payment-adapter.ts:186-188`, `default → ignored`): un reembolso hecho desde el panel de Stripe o un contracargo deja pedido COMPLETED y QR válidos. (3) El camino de salida está bloqueado: «Cancelar» está prohibido en pedidos COMPLETED con tarjeta (`entradas.ts:127-139`) y «Reembolsar» falla porque Stripe responde «charge_already_refunded», que el adaptador devuelve como error y la transacción revierte el estado (`:163-176`; `StripeAdapter.refund` no trata ese caso, `payment-adapter.ts:268-285`; SumUp sí trata «ya reembolsado», `:410-414`). (4) Taquilla con «tarjeta» (datáfono externo) crea `paymentMethod: CARD` sin `paymentId`: el reembolso solo anula entradas, sin devolver dinero (ya conocido; `taquilla/sale/route.ts:126`, `entradas.ts:160`). (5) Sin reembolso parcial/por entrada (Stripe lo soporta: `partialRefunds: true`, sin UI ni ruta; `grep` de «parcial» sin resultados) ni importe de reembolso persistido. (6) Sin email al comprador ni registro de quién reembolsó.

**Escenario.** Soporte reembolsa a un cliente directamente desde el dashboard de Stripe (lo más natural). La app sigue mostrando COMPLETED y su QR sigue entrando; al intentar «Reembolsar» en la app recibe un error de pasarela y no hay forma de anular las entradas, salvo borrar a mano.

**Impacto.** Entradas válidas de pedidos devueltos (fraude fácil), cuadre contable roto, soporte sin herramienta.

**Solución.** (a) Hacer la anulación local la fuente de verdad y reintentable: transacción única «estado → REFUNDING + entradas → REFUNDED», luego pasarela con clave de idempotencia, luego `REFUNDED` (o job de reparación que reintente `REFUNDING`). (b) Procesar `charge.refunded` y `charge.dispute.created` (y el equivalente de SumUp en cron) para anular entradas y avisar. (c) Tratar `charge_already_refunded` como éxito. (d) Reembolso parcial por entrada (`refundTickets(orderId, ticketIds)`) con `Refund` persistido (importe, motivo, usuario). (e) Email de reembolso/cancelación. (f) Para taquilla-tarjeta, rotular «reembolso manual en datáfono».

**Esfuerzo.** M-L. **Confianza.** VERIFICADO.

---

### EN-09 · P1 · Evento cancelado o con cambio de fecha: no hay flujo

**Problema.** Cambiar `status` a `CANCELLED`/`FINISHED` o la `date` desde el admin solo actualiza la fila. No se avisa a compradores, no hay reembolso masivo, las entradas siguen `VALID`, los pases de Wallet siguen vivos, la ficha pública de un evento cancelado sigue enseñando «Comprar entradas» (el botón depende de `soldOut/taquillaOnly/eventEnded`, no de `status`; luego `/comprar` da 404) y el escáner admite la entrada (`scan` no mira `event.status`, EN-13). La ficha tiene CDN de 60 s + 30 s.

**Evidencia.** `app/api/admin/events/[id]/route.ts:55-110` (PUT sin hooks); `grep` de `sendMail(` (solo tickets, wallet, alertas de aforo, contacto, sponsors, reconciliación): no hay email de evento cancelado/cambiado; `app/(public)/eventos/[slug]/page.tsx:190,202` (condiciones de los botones); `app/api/scan/route.ts:36-93` (sin mirar `ticket.event.status`).

**Escenario.** Se cancela un concierto por lluvia: 800 compradores se enteran por redes; soporte reembolsa uno a uno (EN-08, sin parcial ni bulk) y quien no lo pida mantiene QR válidos. Cambio de sábado a domingo: los emails, PDFs y pases existentes dicen sábado.

**Impacto.** Es el «peor día» del organizador; sin herramienta, el coste de soporte es proporcional al número de compradores.

**Solución.** Acción «Cancelar evento» con vista previa (nº de pedidos, importe) que: marca `CANCELLED`, reembolsa en lote (cola con reintentos, usando EN-08), envía email a cada comprador y bloquea ventas/escaneo; acción «Cambiar fecha» que pide confirmación y envía email con las nuevas fecha/hora. Banner público «Evento cancelado» y ocultar botón. Pases de Wallet: ver EN-23.

**Esfuerzo.** L. **Confianza.** VERIFICADO (ausencia comprobada con `grep`).

---

### EN-10 · P1 · Entrega de entradas: emails duplicados, sin reintentos y acoplada al webhook

**Problema.** (1) `completeOrder` no «reclama» el envío: si el pedido ya está COMPLETED continúa a `sendTicketsEmail`, que solo comprueba `emailSentAt` (se escribe DESPUÉS de enviar, `tickets.ts:293-309`). El webhook de Stripe, la verificación de `GET /api/orders/[id]` y el autoenvío del cliente de confirmación llegan a la vez. (2) No hay reintento automático: si el SMTP falla, `emailSentAt` queda null, solo hay filtro `emailFailed` en el admin y reenvío manual (`order-filters.ts:28`, `ventas/page.tsx:341`); el comprador que no vuelve a la confirmación no recibe nada y nadie recibe alerta. (3) El webhook hace `await` de PDF + passes Apple + SMTP antes de responder 2xx a Stripe (`entradas.ts:42-49`, sin `maxDuration` en la ruta): un SMTP lento retrasa el ack y Stripe reintenta. El SMTP es el del cliente (`mailer.ts:52-95`), sin timeouts propios.

**Escenario.** Compra normal: el comprador recibe 2-3 correos idénticos con PDF y `.pkpass`. Compra con SMTP caído 10 minutos: pedidos cobrados sin entrega hasta que alguien lo descubre.

**Impacto.** Ruido de soporte y desconfianza («¿me han cobrado tres veces?»); sin entrega, el comprador llega sin entrada.

**Solución.** Reclamo atómico (`updateMany emailSentAt IS NULL` → `emailClaimedAt`) o `emailSentAt` como compare-and-swap antes de enviar; responder el webhook inmediatamente y enviar con `after()`/cola; cron de reintentos para `COMPLETED AND emailSentAt IS NULL` (con backoff y alerta al operador tras N intentos); `maxDuration`; timeouts de nodemailer.

**Esfuerzo.** M. **Confianza.** VERIFICADO el diseño; la frecuencia de la carrera, PROBABLE.

---

### EN-11 · P1 · Los indicadores públicos de «agotado»/«demanda» usan las entradas escaneadas, no las vendidas

**Problema.** `getEventDemandLevel(maxCapacity, currentCount)` recibe `currentCount`, que solo sube al escanear en puerta (0 hasta la noche del evento). Por tanto «Sin plazas online» y «Alta demanda» no aparecen antes del evento en `/eventos`, en la ficha ni en las seis plantillas. «Desde X €» usa `ticketTypes[0].price` (el primero, no el mínimo, y aunque esté agotado). La ficha sí detecta «Agotado» por tipo (`soldCount`), pero el listado y las portadas siguen diciendo «Plazas disponibles».

**Evidencia.** `lib/ticket-availability.ts:6-11`; `app/(public)/eventos/page.tsx:202,232`; `app/(public)/_home/event-view.ts:48,61`; `app/(public)/eventos/[slug]/page.tsx:88,101`; `event-view.ts:58` (`fromPrice: e.ticketTypes?.[0]?.price`).

**Escenario.** Evento agotado: el listado dice «Plazas disponibles»; el comprador entra, ve «Agotado», se va molesto. Y a la inversa: en el día del evento, con puerta al 96 %, la ficha dice «Alta demanda» aunque sobren entradas.

**Impacto.** Menos conversión en la fase de lanzamiento y quejas; mala señal de escasez.

**Solución.** Calcular disponibilidad como `Σ(maxQuantity − soldCount)` por tipos activos (o `maxCapacity − issued`), y «Desde» como mínimo de los tipos con stock. Test que fije que `currentCount` no interviene.

**Esfuerzo.** S. **Confianza.** VERIFICADO.

---

### EN-12 · P1 · Puerta: fallos mudos del escáner, límite por IP, sin offline ni búsqueda manual

**Problema.**
1. Cuando `/api/scan` responde 429 (límite 120/min por IP), 401 (sesión caducada) o 500, el cliente guarda `data` tal cual en `scanResult`: sin `message` ni `color`, el overlay queda sin fondo con un ❌ y texto vacío (`access-client.tsx:122, 152-157, 164-172`). El personal no sabe si es un QR inválido o un fallo.
2. `rateLimit('scan', IP, 120, 60_000)` por IP (`scan/route.ts:19`): varias puertas en la misma wifi del recinto comparten IP; a ~2 lecturas/s agregadas empiezan los 429. Además cada escaneo ejecuta un upsert en Postgres (`rate-limit.ts`).
3. Tras cada lectura la cámara queda bloqueada hasta tocar la pantalla o 4 s (`access-client.tsx:135-138`).
4. Sin modo offline: el QR es un UUID opaco (`LG-<uuid>`, `qr.ts:5`) sin firma, validable solo contra la BD. Un corte de red = puerta parada; si la respuesta se pierde tras escribir, la reescaneada sale «YA ENTRÓ».
5. El personal no puede buscar al asistente por nombre/email/referencia ni hacer check-in manual (el modo «Manual» solo acepta el código; `/api/admin/scans` es de consulta; TAQUILLA no tiene búsqueda de pedidos). El caso «no encuentro el email» es el nº 1 de soporte en puerta.
6. «Hora de entrada» del mensaje de duplicado se formatea en el servidor sin zona → UTC (`scan/route.ts:116,166`).
7. Sin reentrada: un `USED` siempre es DUPLICATE (salir a fumar = no puede volver), `currentCount` solo sube salvo anulación de invitación.

**Escenario.** Apertura de puertas de un festival: 4 puertas con la wifi del recinto; a los 5 minutos todas las puertas muestran ❌ mudo; el equipo deja pasar sin validar.

**Impacto.** Cuellos de botella y colas en el momento de mayor visibilidad del producto.

**Solución.** (a) Mapear `!res.ok` a mensajes («Demasiados escaneos», «Sesión caducada: vuelve a entrar», «Error del servidor, reintenta») con colores; (b) límite por usuario de sesión + por IP muy alto, o sin límite para staff autenticado; (c) buscar-y-admitir: `GET /api/access/search?q=` (TAQUILLA) y `POST /api/scan` con `ticketId`+motivo registrado en `ScanLog`; (d) escáner PWA con lista descargable de hashes de QR VALID por evento y cola de sincronización (roadmap del plan, M); (e) `timeZone` en los mensajes; (f) opción por evento «permitir reentrada» con escaneos de salida.

**Esfuerzo.** M (a, b, c, e) / L (offline, reentrada). **Confianza.** VERIFICADO.

---

### EN-13 · P1 · El escáner no comprueba el estado del pedido ni del evento

**Problema.** `scan` solo mira `ticket.status` (`CANCELLED`, `REFUNDED`, `PENDING`, `USED`, `VALID`). Aunque hace `include: { order: true, event: true }`, nunca usa `order.status` ni `event.status`/fecha. La comprobación de evento solo existe si el cliente manda `eventId` (opcional en el esquema, `scan/route.ts:12-15,44`); la UI sí lo manda.

**Escenario.** (1) Pedido `REFUNDED` zombi (EN-08) o reembolsado en Stripe (EN-08): QR válido, entra. (2) Evento `CANCELLED`/`FINISHED`: «ACCESO PERMITIDO». (3) Un cliente de API o un lector externo sin `eventId`: un ticket de otro evento o de otra fecha se marca USED e incrementa el aforo del otro evento.

**Impacto.** Entradas anuladas que entran; el aforo de otro evento contaminado.

**Solución.** En `scan`: rechazar si `order.status` ∉ {COMPLETED} (con motivo), si `event.status` ∈ {CANCELLED, DRAFT}, y exigir `eventId` (o ventana de fechas: inicio − 12 h … inicio + 24 h) con aviso en lugar de bloqueo duro configurable.

**Esfuerzo.** S. **Confianza.** VERIFICADO.

---

### EN-14 · P1 · Sin recuperación de entradas ni asignación por entrada

**Problema.** (a) No existe «Recuperar mis entradas»: el acceso al pedido es un token HMAC de 16 caracteres que solo viaja en el email/URL de confirmación (`access-token.ts:34`, `grep` de «mis entradas|recuperar»: sin resultado fuera del texto del botón del email). Si el comprador pierde el correo, solo soporte puede reenviar desde el admin. (b) Entradas nominativas: no existe asignación de nombre por entrada, ni cambio de titular, ni transferencia, ni reenvío por entrada (`grep` de «holderName»: solo se fija en la creación con `buyerName + buyerLastName`; `grep` de transfer/nominativ: sin resultado). Un pedido de 4 entradas lleva un solo PDF con 4 QR a nombre del comprador; el comprador reenvía el PDF entero y cualquiera de los 4 QR sirve a cualquiera (primero que llega gana).

**Escenario.** Grupo de 6 amigos: el que compró reenvía el PDF por WhatsApp; un amigo lo reenvía a otro; un QR se cuela; se descubre en puerta por DUPLICATE. O: «no me llega el email» → ticket a soporte.

**Impacto.** El mayor generador de tickets de soporte en eventos de venta online; y requisito habitual en Eventbrite/Ticketmaster.

**Solución.** Página `/mis-entradas` (email → email con enlace mágico a los pedidos de ese email; respuesta idéntica exista o no el email; rate limit + Turnstile). Enlace por entrada (`/t/<token>`) con PDF/QR/Wallet individual y «enviar a un amigo» (email), con nombre opcional editable hasta N horas antes (`holderName` por ticket) y registro de cambios. Para eventos con DNI/nominativas estrictas: campo obligatorio por entrada y comprobación en puerta (roadmap, L).

**Esfuerzo.** M (recuperación + enlace por entrada) / L (nominativas estrictas con transferencia). **Confianza.** VERIFICADO (ausencia, con `grep` en todo el repo).

---

### EN-15 · P1 · Contraste del importe cobrado: ausente en el camino principal y frágil por redondeo

**Problema.** (a) El webhook de Stripe llama `resolvePaidCheckout(event.orderId, baseUrl)` → `completeOrder(orderId, baseUrl)` sin `paid`, así que `paymentMatchesOrder` devuelve `true` siempre (`webhook-handler.ts`, `order-reconciliation.ts:10-12`, `shared.ts:17`); el evento ni siquiera lleva `amount` (`payment-adapter.ts:42-45`). El plan da el punto «importe cobrado vs total» por hecho; solo se aplica en cron, confirmación (`GET /api/orders/[id]`) y verificación manual. (b) Donde sí se aplica, el total del pedido se calcula en coma flotante sin redondear (`calculateCommission` devuelve `subtotal * pct/100`, `lib/pricing.ts`), Stripe recibe `Math.round(total*100)` y la BD guarda `Decimal(10,2)` redondeado distinto. Reproducido con `node`: con comisión 1,5 %, subtotal 33 € → total 33.495: Stripe cobra 33,49 € y la BD guarda 33,50 €; diferencia 0,00999999999999801 o 0,0100000000000051 según el caso, frente a la tolerancia `< 0.01` (`shared.ts:21-22`). En una barrida de 7.810 combinaciones (comisiones 1,5-7,5 %) el 1,4 % dio céntimo distinto.

**Escenario.** Cliente con comisión ≠ 0 y SumUp (sin webhook): el pedido pagado se compara en la verificación, falla por 1 céntimo, no se completa, se manda un aviso al operador y el comprador queda sin entrada hasta intervención manual. Con Stripe se cura solo cuando llega el webhook (que no comprueba), pero el orden carrera/confirmación puede mandar avisos falsos.

**Impacto.** Con comisión 0 (valor por defecto) no ocurre; con comisión activa produce pagos «huérfanos» intermitentes y avisos de falsa alarma.

**Solución.** Calcular todo en céntimos enteros (o `Decimal`), redondear la comisión a céntimos una sola vez y usar ese valor para BD y pasarela; tolerancia ≤ 1 céntimo explícita en enteros; pasar `amount_total` en `WebhookEvent` y aplicar el contraste en el webhook también.

**Esfuerzo.** M. **Confianza.** VERIFICADO (aritmética y lectura); la incidencia real depende de la comisión.

---

### EN-16 · P1 · SumUp: entrega y capacidad dependientes del cron; reembolso sin prueba real

**Problema.** SumUp no tiene webhook (`payment-adapter.ts:311`): un pedido pagado se completa si el comprador vuelve a la confirmación o por el cron (cada 5 min, 50 pedidos por lista y pasada, en serie, con `sendTicketsEmail` dentro de la pasada: `reconcile-payments/route.ts:26, 122-143`). En una venta grande, los pedidos impagados ocupan la cola (los no examinados primero) y retrasan los pagados; sin `maxDuration` en la ruta. El reembolso de SumUp se ha reescrito (consulta del checkout → reembolso de la transacción `/v1.0/merchants/{code}/payments/{tx}/refunds`, `payment-adapter.ts:401-432`, resolviendo el punto ya anotado en el plan), pero no hay prueba contra la pasarela real ni test del camino; sin clave de idempotencia (compensado leyendo `REFUNDED`).

**Escenario.** 800 compras con SumUp en 10 min, la mitad de compradores cierran la pestaña tras pagar: 400 pedidos esperan 8 pasadas (40 min) a recibir sus entradas, mientras 200 carritos impagados consumen turnos de verificación.

**Impacto.** Retrasos de entrega, tickets «he pagado y no me llega» en la ventana de lanzamiento.

**Solución.** Priorizar en el cron los pedidos con `paymentId` y antigüedad < 1 h antes que los viejos, subir `BATCH_SIZE` con paralelismo acotado, completar y enviar en dos fases (marcar pagados primero; emails después, EN-10), `maxDuration`, y reflejar en la guía de alta que Stripe es la pasarela recomendada para eventos grandes. Probar el reembolso de SumUp en sandbox/real antes de ofrecerlo.

**Esfuerzo.** M. **Confianza.** PROBABLE.

---

### EN-17 · P1 · Sala de espera en Postgres (ya conocido; sigue abierto)

**Problema.** Cada sondeo de estado/entrada ejecuta: upsert de rate-limit en Postgres, lectura de evento, `sweepAndAdmit` (transacción con advisory lock + `UPDATE` + `COUNT` + `UPDATE ... LIMIT`), lectura de la entrada y `COUNT` de posición O(n) (`queue/status/route.ts:26-60`, `queue/join/route.ts:60-102`, `lib/waiting-room.ts:49-73`). El cliente sondea cada 8 s (>50 puestos), 5 s (>10) o 2 s (`waiting-room-gate.tsx:36-42`). Con 5.000 personas esperando: ~600 sondeos/s ≈ 5.000 consultas/s a una BD pensada como Neon gratuita con un solo lock caliente por evento. `/comprar` (no cacheada) también golpea la BD por cada visitante.

**Evidencia adicional.** El diseño y los números están en el plan («se mueve fuera de Postgres antes de una venta grande»); no hay prueba contra Neon (`loadtest/README.md`: solo local y con pasarela mock).

**Impacto.** Si la BD se degrada, se degrada también el checkout y el cobro (comparten BD y pool) justo en el pico.

**Solución.** Mover el estado de la cola a Redis/Upstash (ya hay Upstash en la guía de despliegue) con admisión por lotes y posición aproximada; mientras tanto: sondeo 10-15 s con jitter para posiciones >100, caché de posición, ejecutar `sweepAndAdmit` por cron/único «líder» cada 1-2 s en lugar de en cada sondeo, y no incluir la sala en la misma BD de pedidos. Ejecutar `race.js`/`checkout-flow.js` contra un preview Vercel+Neon real antes de la primera venta.

**Esfuerzo.** L. **Confianza.** VERIFICADO el coste por sondeo; la capacidad real, HIPÓTESIS.

---

### EN-18 · P1 · Entradas gratuitas o de importe < 0,50 € no se pueden vender online

**Problema.** `price` admite 0 (`admin/ticket-types/route.ts:13,35`), pero `POST /api/orders` siempre crea una sesión de pago cuando la pasarela es real (`orders/route.ts:327-351`), sin caso especial para `totalAmount === 0`. Stripe exige al menos 50 céntimos en modo `payment`; la llamada falla, la compensación cancela el pedido y el comprador recibe «No se ha podido iniciar el pago» (502).

**Escenario.** El organizador crea un tipo «Lista gratuita» o una entrada de 0 € para un evento con registro: nadie puede apuntarse online.

**Impacto.** Fricción en la semana 1 con eventos con inscripción gratuita (habituales en cultura/ferias).

**Solución.** Si `totalAmount === 0`, completar el pedido directamente (status COMPLETED, tickets VALID, email) sin pasarela, con el mismo lock; validar importes entre 0,01 y 0,49 € como error de configuración al crear el tipo.

**Esfuerzo.** S. **Confianza.** PROBABLE (el mínimo de Stripe es comportamiento externo; el código no tiene la rama).

---

### EN-19 · P1 · Cumplimiento en el checkout: sin aceptación explícita ni registro

**Problema.** El formulario solo muestra «Al pagar aceptas las condiciones de acceso» si el evento tiene texto de condiciones (`buy-tickets-form.tsx:224-232`); no hay casilla ni enlace a privacidad/aviso legal, ni mención al régimen de desistimiento de entradas de espectáculos, ni casilla separada de marketing. El aviso de edad es un modal en la ficha que se salta entrando directamente a `/comprar` (`age-warning-gate.tsx`), y la autorización de menores es una plantilla en PDF sin verificación (`minor-authorization/route.ts`). No se guarda la aceptación (ni versión de condiciones ni marca de tiempo) en el pedido.

**Impacto.** Información de RGPD al recoger datos y prueba de aceptación son requisitos básicos para vender a consumidores en España; el abogado que revisa el plan debería validar este punto antes de vender.

**Solución.** Casilla obligatoria «He leído las condiciones y la política de privacidad» (enlaces a `/legal/*`) y texto fijo sobre no-desistimiento (evento con fecha), guardar `termsAcceptedAt`/`termsVersion`/`ageConfirmedAt` en `Order`; mover el aviso de edad al formulario. Casilla opcional de marketing separada.

**Esfuerzo.** S-M. **Confianza.** VERIFICADO (ausencia en el formulario; el criterio jurídico es del abogado).

---

### EN-20 · P2 · Estadísticas y exportaciones

- «Entradas vendidas» cuenta todo ticket no CANCELLED/REFUNDED: incluye `PENDING` (impagados), invitaciones y taquilla gratis, mientras ingresos suma solo pedidos `COMPLETED` (`admin/stats/route.ts:30-34, 107-112`; `access/capacity/route.ts:24`; `noche/route.ts:49`).
- Ingresos no restan ni muestran reembolsos; `netRevenue = total − comisión` etiqueta como «neto» algo que no descuenta reembolsos ni tasas de la pasarela.
- Series por día en UTC (`stats/route.ts:94-101`; la de `ventas-por-dia` ya usa Madrid) y `ordersForChart` carga todos los pedidos sin límite.
- Exportaciones truncan en silencio a 5.000/10.000 filas y no incluyen estado de reembolso/importe reembolsado ni fecha en Madrid (`export/route.ts:85, 125`); incluyen el QR completo (los asistentes exportados valen como entradas).
- `GET /api/admin/orders`: máximo 200 filas sin paginación (`admin/orders/route.ts:21`).

**Solución.** Definir «vendida = COMPLETED + VALID/USED» y «retenida = PENDING» por separado; columnas de reembolsos; paginación por cursor y exportación en streaming/por lotes; quitar el QR del CSV (o parcial). **Esfuerzo.** M. **Confianza.** VERIFICADO.

---

### EN-21 · P2 · TAQUILLA/ADMIN: controles internos

- TAQUILLA emite entradas gratis (`paymentMethod: 'free'`) y crea invitaciones (hasta 20 por llamada) sin cupo, motivo ni aprobación (`taquilla/sale/route.ts:34,82-85`, `invitations/route.ts:58`); la cantidad de taquilla no tiene tope superior (`Math.max(1, parseInt(...))`, `:75`; `parseInt('abc')` da NaN → 500).
- `DELETE /api/invitations` (TAQUILLA permitido) anula también entradas `USED` y decrementa `currentCount` (`invitations/route.ts:171-186`): borra evidencia de entrada.
- La taquilla no comprueba `ticketType.isActive` ni `event.status`/fin de evento (`taquilla/sale/route.ts:96-103`): permite vender un tipo desactivado o un evento cancelado/borrador (el plan lo daba por cerrado solo para «otro evento»).
- Datos de relleno con dominio de marca: `taquilla@lagrailla.local`, `invitacion@lagrailla.local` (`taquilla/sale/route.ts:123`, `invitations/route.ts:79`) en clientes ajenos a La Grailla; el email de entradas de una invitación dice «Tu compra se ha completado… Total 0,00 EUR» (`lib/tickets.ts:147-160`).
- Sin tabla de auditoría de acciones de staff (reembolsos, anulaciones, emisiones) más allá de `soldById`/`createdById`/`ScanLog`.

**Solución.** Cupos por usuario/evento, campo «motivo», auditoría `StaffAction`, bloquear `DELETE` con USED salvo ADMIN, mismas reglas de venta que online en taquilla (con excepción explícita), remitentes de relleno neutros o por cliente. **Esfuerzo.** M. **Confianza.** VERIFICADO.

---

### EN-22 · P2 · Rendimiento y robustez

- Índices: `Ticket` solo tiene `(eventId)`, `(orderId)`, `(ticketTypeId)`; el `COUNT` por `eventId`+`status` bajo el lock recorre todas las entradas del evento en cada compra (`orders/route.ts:213`) y el recuento por email hace `ILIKE` (`mode: 'insensitive'`) sobre `buyerEmail` sin índice funcional. A 10-20 k entradas el tiempo dentro del lock crece y reduce el throughput por evento. Añadir `@@index([eventId, status])`, `Order(eventId,status,createdAt)`, `ScanLog(eventId,createdAt)`, índice por `lower(buyerEmail)` (ya listado en el plan). HIPÓTESIS de magnitud.
- `void checkCapacityAlerts(...)` sin `await` ni `after()` en `scan`, `taquilla/sale`, `orders` (mock): en serverless, el trabajo tras la respuesta puede cortarse; las alertas de aforo pueden perderse (PROBABLE).
- `POST /api/orders` no define `maxDuration` aunque la transacción espera hasta 20 s por el lock (`orders/route.ts:284-285`): con el límite por defecto de la función, compradores en cola pueden recibir 504 sin saber si el pedido se creó (la idempotencia lo mitiga). HIPÓTESIS (depende del plan de Vercel/Fluid).
- `GET /api/orders/[id]` llama a Stripe en cada sondeo mientras el pedido está PENDING (cada 3 s, 15 veces, `confirmation-client.tsx:33-34`): en el pico se acerca al límite de lectura de Stripe; solo degrada el sondeo (errores capturados). PROBABLE.
- Datos monetarios `Float` en la aplicación aunque la columna es `Decimal` (ver EN-15).

**Esfuerzo.** S-M. **Confianza.** PROBABLE / HIPÓTESIS (indicado en cada punto).

---

### EN-23 · P2 · Gaps frente a Eventbrite / Ticketmaster (ausencias comprobadas con `grep`)

| Capacidad | Estado | Esfuerzo |
|---|---|---|
| Ventana de venta por fecha por tipo/fase (`saleStart/saleEnd`) | No existe: `phase`/`phaseName` son etiquetas; el admin activa/desactiva a mano (`grep` sin resultado) | M |
| Códigos promocionales / accesos anticipados | No existe | M |
| Lista de espera de agotadas / «avísame» | No existe | M-L |
| Reentrada y salida | No existe (EN-12) | M |
| Factura/justificante por pedido | Solo el email de entradas | M |
| Apple Pay / Google Pay / Bizum | Stripe Checkout con `payment_method_types: ['card']` (`payment-adapter.ts:221`): wallets en tarjeta sí, Bizum/otros no | S-M |
| Pase de Wallet actualizable/anulable, `relevantDate` | No (ya conocido: tras reembolso o cambio de fecha el pase sigue vivo, `lib/wallet.ts`) | M |
| QR rotativo / anti-captura (SafeTix) | No: QR estático UUID; copiable por captura | L |
| Zonas con aforo propio, abonos, multi-evento | No | L |
| Email de recordatorio al comprador, de pago fallido, de cancelación/reembolso | No existen | S-M cada uno |

---

## 3. Casos límite críticos — resumen de resultado

| Caso | Resultado |
|---|---|
| (a) Últimas entradas, dos compras simultáneas | Seguro (lock por evento + recuento dentro del lock). Sin lectura-modificación-escritura fuera del lock. |
| (a) Online + taquilla (+ invitaciones) | Seguro: misma clave de lock en las tres. |
| (b) Webhook duplicado / fuera de orden | Seguro (updateMany condicionado, dedup tras procesar). |
| (b) Pago tras caducar la reserva | **Sin recuperación automática** → EN-04 (+ UI engañosa EN-05). |
| (c) Abandono tras retención bancaria / pago pendiente | Aforo retenido 24 h → EN-01; ventana de carrera cron/webhook sin daño (ambos son CAS), salvo pago tardío → EN-04. |
| (d) Doble envío / reintentos | Idempotente, pero sin enlace de pago al reintentar → EN-07. |
| (e) Cobrado pero email/PDF fallido | Sin reintento automático ni alerta; duplicados → EN-10. |
| (f) QR válido de pedido reembolsado/anulado | Entradas CANCELLED/REFUNDED se rechazan; pero pedido REFUNDED con entradas VALID (zombi / reembolso fuera de la app) entra → EN-08, EN-13. |
| (g) Evento cancelado / cambio de fecha | Sin aviso, sin reembolso, sin bloqueo → EN-09. |
| (h) Zona horaria | Entrada en UTC vs. salida en Madrid → EN-02. |

## 4. Licencia/módulo apagado (punto 4 del alcance)

- `/api/scan`, `/api/access/*`: exentos de fase y de módulo (verificado, con tests).
- `/acceso` (pantalla) y `/api/events`: **no** exentos → EN-03. Cliente suspendido: todo se corta salvo webhooks, crons y health → incluye el escáner.
- Webhooks y crons nunca se cortan (verificado); lectura de confirmación/pedido/PDF por el comprador exenta; reembolsos PATCH exentos, pero la pantalla `/admin/ventas` que los usa se corta en BLOCKED (solo vía API).
- PANEL_BLOCKED: las ventas y el escáner siguen; se cortan `/api/invitations` y `/api/guest-lists` (pestaña Invitaciones del escáner) y `/admin/noche`.

## 5. Orden de ataque sugerido (para la semana previa a la primera venta)

1. EN-02 (fecha/zona) y EN-03 (allowlist de la puerta): S, sin riesgo, evitan los dos fallos más visibles.
2. EN-01 + EN-04 + EN-05 + EN-07: un único paquete de «ciclo de vida del pedido pendiente» (retención 30 min, liberación en `cancelUrl`, pago tardío con reembolso automático, estados en UI, reanudar pago). M-L.
3. EN-13, EN-12(a)(b)(e), EN-11, EN-10: arreglos pequeños de alto retorno en puerta y confirmación.
4. EN-15 (céntimos enteros) antes de activar cualquier comisión; EN-18 y EN-19 antes de la primera venta pública.
5. EN-08, EN-09, EN-14, EN-17: segunda tanda (antes de un evento grande), con prueba real contra Stripe/Neon.

## 6. Pendiente de verificar con infraestructura real (no hecho aquí)

- Que el proceso de Vercel corre en UTC en producción (EN-02).
- Comportamiento de SumUp: caducidad de checkouts, formato de importes, reembolso (EN-04, EN-15, EN-16).
- Duración efectiva del webhook con PDF + SMTP del cliente y límites de función (EN-10, EN-22).
- Capacidad de la sala de espera y del lock por evento sobre Neon (EN-17, EN-22); `race.js`/`checkout-flow.js` solo se han corrido en local con pasarela mock.
- Pago real de extremo a extremo (ya conocido).
