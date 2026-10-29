# Evento cancelado y cambio de fecha (P1-04)

## Cancelar un evento
En `/admin/eventos`, botón **Cancelar evento** (icono de prohibido) de cada evento. La ventana enseña **antes de hacer nada**:
- pedidos pagados con tarjeta que se reembolsan solos (número e importe),
- pedidos que **no** se reembolsan solos (efectivo, gratuitos, invitaciones, entradas ya usadas),
- pedidos sin pagar (se anulan y se cierra su sesión de pago),
- compradores online a los que se puede avisar.

Hay dos opciones (**reembolsar** y **avisar**) y una confirmación escrita (`CANCELAR`). Al confirmar:
1. El evento pasa a `CANCELLED` **al instante**: se cierra la venta, el escáner rechaza sus entradas (P1-02) y la ficha pública dice «Evento cancelado». Un pago que llegue tarde se reembolsa en vez de reanimar entradas.
2. Se anota un **trabajo reanudable** (fila de sistema `event_cancellation:<id>` en AppConfig, sin migración) y se procesa un primer lote en la misma petición.
3. El resto sigue **solo** en cada pasada del cron de reconciliación (cada pocos minutos) o con el botón **Continuar ahora**. La ventana puede cerrarse sin perder nada.

### Qué se reembolsa solo
Pedidos `COMPLETED` pagados con tarjeta en una pasarela real, con pago asociado y **sin entradas ya usadas**. Se reembolsa el total del pedido (comisión incluida) con `invalidateOrder`, que reclama el estado del pedido con un compare-and-swap: relanzar el trabajo no reembolsa dos veces.

Un reembolso que falla se reintenta hasta 3 veces **con espera**: 2 minutos tras el primer fallo y 10 tras el segundo (el diálogo sondea cada segundo y el cron cada pocos minutos; sin espera, los intentos se agotaban en segundos). La ventana muestra «Reintentando a las HH:MM» y deja de insistir hasta entonces; el cron sigue solo. Cada llamada a la pasarela tiene un tope de tiempo (25 s en la ventana, 8 s en el cron): si no responde, cuenta como fallo y se reintenta más tarde, sin bloquear el lote. Agotados los intentos, el pedido queda **«a resolver a mano»** en la ventana y se avisa al comprador de que el reembolso lo gestiona el organizador (nunca se le dice que ya se le devolvió).

**Reembolso a medias**: si un pedido consta como reembolsado pero sus entradas siguen activas (el proceso murió entre medias), no se le escribe «hemos devuelto»: aparece en «A resolver a mano» para revisar el cobro en la pasarela.

### Avisos por email
Un email por pedido online (nunca a taquilla ni a invitaciones ni a direcciones `.local`), con lo que pasa con su dinero: devuelto, pendiente de gestión o pedido gratuito. «Ya se avisó» se guarda en filas marcadoras de `ProcessedWebhookEvent` (`event-cancel-mail:<pedido>`), reclamadas **antes** de enviar y liberadas si el envío falla. Un envío fallido se reintenta hasta 5 veces con espera creciente (1, 5, 15 y 60 minutos). Si se agotan (SMTP caído, límite de envío…), el trabajo termina igualmente y la ventana dice «N sin enviar (revisa el SMTP)» y los lista en «A resolver a mano»: nada se pierde en silencio. Se avisa solo cuando el estado del dinero ya es final: mientras un reembolso se reintenta, no se escribe nada falso. Los pedidos reembolsados **antes** de cancelar el evento no reciben un segundo aviso.

**Antes de cancelar un evento grande, comprobar que el SMTP del cliente funciona** (Configuración → Conexiones): sin correo, los compradores no se enteran.

## Cambiar la fecha
Al guardar un evento con compradores online y una fecha distinta (más de un minuto), el servidor responde 409 y la pantalla pregunta: **Cambiar y avisar**, **Cambiar sin avisar** o **Volver**. Con aviso, cada comprador recibe un email con la fecha anterior y la nueva (una sola vez por cambio; si la fecha vuelve a cambiar, se avisa de nuevo; si el aviso anterior no había terminado, a los que faltan se les dice como «antes» la fecha original, no la intermedia). Las entradas siguen siendo válidas: el QR no cambia. Los PDF ya descargados y los pases de Wallet pueden mostrar la fecha anterior.

## Lo que NO hace (todavía)
- **No reembolsa efectivo ni pagos de taquilla**: el organizador lo gestiona; el comprador online recibe un aviso con esa indicación.
- **Reembolso parcial o por entrada**: no existe (P1-01).
- **No avisa a quien compró en taquilla** (no hay email fiable).
- **Los pases de Google Wallet ya emitidos** siguen existiendo en el móvil, aunque el escáner los rechaza (EN-23).
- **No probado con Stripe ni SumUp reales**: hacer un evento de prueba con una compra de importe mínimo y cancelarlo antes de usarlo con clientes.
- Cancelar con un simple cambio de estado de un evento con pedidos ya no se permite: el servidor lo rechaza (409) y lleva a este flujo.
- **Un evento cancelado con este flujo no se puede volver a publicar** (409 `cancelled_event_locked`): ya se reembolsó y se avisó. Si fue un error, se crea un evento nuevo.
- Límites conocidos y aceptados: dos pasadas simultáneas pueden pisarse el contador de reintentos del trabajo (solo alarga la espera, nunca duplica un reembolso ni un aviso); un pago que llega tarde sobre un pedido pendiente anulado puede dar un aviso confuso; no hay tope para fallos persistentes al anular pedidos pendientes.
