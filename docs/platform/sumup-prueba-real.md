# SumUp: prueba real antes de vender con ella (P1-13)

**Por qué hace falta.** SumUp no tiene webhook y su reembolso reembolsa la **transacción** del checkout, no el checkout. El código está cubierto por tests con respuestas simuladas (`tests/lib/payment-adapter-lifecycle.test.ts`), pero **esos tests solo prueban que el código hace lo que creemos que SumUp responde**. Nadie ha comprobado todavía que SumUp responda así. Esta guía lo comprueba con dinero real y poco (1 €), y es el único modo de saberlo.

**Quién la hace:** el dueño o quien tenga la cuenta de SumUp del cliente. **Cuándo:** una vez por cuenta de cliente antes de abrir la venta, y otra vez si SumUp cambia su API. **Dónde:** en el despliegue del cliente (nunca contra la BD de otro). **Coste:** unos céntimos de comisión; los reembolsos devuelven el importe.

Prepara un evento de prueba con una entrada de **1,00 €**, publicado solo para ti (o con la venta cerrada al público). Anota el resultado de cada paso; si un paso no sale como dice «esperado», **para y avisa**: no vendas con SumUp hasta resolverlo.

| # | Paso | Esperado | Qué demuestra |
|---|---|---|---|
| 1 | En `/admin/configuracion`, pasarela SumUp, pulsa **Probar conexión** | Verde. Con una clave mala, rojo con el motivo | La clave y el código de comerciante son válidos |
| 2 | Compra 1 entrada con tarjeta y **vuelve a la web** tras pagar | Llegan la confirmación y el email con la entrada | El camino normal (regreso del comprador) |
| 3 | Compra otra entrada, **paga y cierra la pestaña** sin volver | En la siguiente pasada del cron (cada 5 minutos; normalmente ≤ 10) la entrada pasa a VÁLIDA y llega el email, sin tocar nada | **El cron sustituye al webhook** (la pieza que SumUp no tiene) |
| 4 | Empieza otra compra, **llega al pago y no pagues** (y no vuelvas atrás desde SumUp) | El checkout caduca a los 30 minutos; el cron libera el aforo y cancela el pedido pasados **40 minutos** (30 más 10 de gracia), así que cuenta unos 40–45. Si vuelves atrás desde SumUp, se libera al momento | Que los carritos abandonados no retienen entradas para siempre |
| 5 | En el admin, **reembolsa completo** la compra del paso 2 | Pedido REFUNDED, entrada anulada, y el dinero de 1 € aparece como reembolsado en SumUp | **El reembolso reescrito funciona** |
| 6 | Repite el reembolso del paso 5 (pulsa otra vez / reintenta) | No da error ni duplica: sigue REFUNDED | Que un reintento no se atasca (SumUp no tiene clave de idempotencia) |
| 7 | Mira el `Salud` del cliente en el panel | Sin avisos de «cobros sin pedido» ni de pedidos atascados | Que lo anterior no dejó restos |

**Si el paso 3 tarda más de 10 minutos**, mira el panel (`Salud`: pedidos PENDING con pago sin resolver) y la tarea `reconcile-payments`. Con una venta grande el cron examina hasta **100 pedidos con pago por lista y pasada** (entradas y tienda, intercaladas; variable `RECONCILE_GATEWAY_BATCH`) y una pasada cada 5 minutos, con un presupuesto de unos 35 s por pasada. **Cuenta todos los PENDING con pago, no solo los pagados:** los carritos que llegaron a SumUp y no se pagaron compiten por el mismo lote hasta que se liberan (40 min). Con 400 pagos y muchos carritos abandonados al mismo tiempo, cuenta **más de 4 pasadas (20 min)**; 4 es el mejor caso, si todos están pagados. Una SumUp lenta recorta lo que cabe en una pasada: lo que no cabe queda para la siguiente.

## Recomendación para eventos grandes

**Stripe es la pasarela recomendada** para un evento con mucha demanda: confirma el pago por webhook en segundos y no depende de que el comprador vuelva ni de un cron. Con SumUp, la entrega depende de que el comprador vuelva a la web o de la siguiente pasada del cron (hasta unos minutos, más en un pico). Úsala si el cliente ya la tiene o prefiere su cuenta, y avísale de este límite antes de una venta grande.

## Riesgos conocidos (no se han resuelto)

- **Un reembolso hecho a mano en el panel de SumUp NO se detecta.** El pedido sigue COMPLETED y sus entradas, activas. La conciliación diaria de SumUp solo revisa pedidos PENDING y CANCELLED (para Stripe sí se detecta «reembolsado pero activo»). **Reembolsa siempre desde el admin de la web**, nunca a mano en SumUp. Detectarlo exigiría que la conciliación diaria contraste también los pedidos COMPLETED recientes con la pasarela: queda anotado, no hecho.
- **No hay reembolso parcial con SumUp:** el admin solo reembolsa por completo, y el adaptador rechaza un importe cero, negativo o mayor que lo cobrado (en vez de devolverlo entero en silencio).
- **Supuestos sobre la API de SumUp que solo esta prueba despeja:** que el endpoint de reembolso del código sea el vigente, y que tras reembolsar, la transacción del checkout pase a `REFUNDED`. Si siguiera como `SUCCESSFUL`, la web no vería los reembolsos y un reintento tras un éxito perdido recibiría un 409. **El paso 5 (y el 6) existen para comprobarlo: si el 6 da error, páralo y avisa.**

## Lo que sí está cubierto por el código

- Todas las llamadas a SumUp tienen **tope de tiempo** (10–15 s). Si SumUp no contesta al crear el checkout, la compra falla limpia (se cancela el pedido y se libera el aforo) en vez de quedarse colgada.
- La cola del cron es **justa**: lo que nunca se examinó va primero; entradas y tienda se intercalan para que una pasada corta no deje a la tienda sin atender; un fallo de SumUp no libera entradas de pedidos que podrían estar pagados (la decisión solo libera con SumUp confirmando que el pago ya no puede llegar).
- Una SumUp **colgada** no pierde la pasada entera: cada grupo de 5 pedidos tiene un tope duro (la pasada termina en unos 45 s como máximo), se registra el resumen y lo no atendido sigue PENDING para la siguiente.
- Un pago de SumUp sin pedido guardado (el `paymentId` no llegó a grabarse) lo encuentra la conciliación diaria por la referencia del checkout.
