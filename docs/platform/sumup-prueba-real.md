# SumUp: prueba real antes de vender con ella (P1-13)

**Por qué hace falta.** SumUp no tiene webhook y su reembolso reembolsa la **transacción** del checkout, no el checkout. El código está cubierto por tests con respuestas simuladas (`tests/lib/payment-adapter-lifecycle.test.ts`), pero **esos tests solo prueban que el código hace lo que creemos que SumUp responde**. Nadie ha comprobado todavía que SumUp responda así. Esta guía lo comprueba con dinero real y poco (1 €), y es el único modo de saberlo.

**Quién la hace:** el dueño o quien tenga la cuenta de SumUp del cliente. **Cuándo:** una vez por cuenta de cliente antes de abrir la venta, y otra vez si SumUp cambia su API. **Dónde:** en el despliegue del cliente (nunca contra la BD de otro). **Coste:** unos céntimos de comisión; los reembolsos devuelven el importe.

Prepara un evento de prueba con una entrada de **1,00 €**, publicado solo para ti (o con la venta cerrada al público). Anota el resultado de cada paso; si un paso no sale como dice «esperado», **para y avisa**: no vendas con SumUp hasta resolverlo.

| # | Paso | Esperado | Qué demuestra |
|---|---|---|---|
| 1 | En `/admin/configuracion`, pasarela SumUp, pulsa **Probar conexión** | Verde. Con una clave mala, rojo con el motivo | La clave y el código de comerciante son válidos |
| 2 | Compra 1 entrada con tarjeta y **vuelve a la web** tras pagar | Llegan la confirmación y el email con la entrada | El camino normal (regreso del comprador) |
| 3 | Compra otra entrada, **paga y cierra la pestaña** sin volver | En ≤ 10 minutos la entrada pasa a VÁLIDA y llega el email, sin tocar nada | **El cron sustituye al webhook** (la pieza que SumUp no tiene) |
| 4 | Empieza otra compra, **llega al pago y no pagues** | El aforo vuelve en cuanto caduca el checkout (retención corta) y el pedido pasa a CANCELADO | Que los carritos abandonados no retienen entradas |
| 5 | En el admin, **reembolsa completo** la compra del paso 2 | Pedido REFUNDED, entrada anulada, y el dinero de 1 € aparece como reembolsado en SumUp | **El reembolso reescrito funciona** |
| 6 | Repite el reembolso del paso 5 (pulsa otra vez / reintenta) | No da error ni duplica: sigue REFUNDED | Que un reintento no se atasca (SumUp no tiene clave de idempotencia) |
| 7 | Compra 2 entradas (2 €) y haz un **reembolso parcial** de 1 € (si el admin lo ofrece) | SumUp muestra 1 € reembolsado y el pedido refleja el parcial | El reembolso parcial; si no se ofrece, solo se reembolsa por completo |
| 8 | Reembolsa **desde el panel de SumUp** (a mano) la compra del paso 3 | En ≤ 24 h la web lo detecta (conciliación diaria) y anula las entradas, o el pedido pasa a REFUNDED | Que un reembolso hecho fuera de la app no deja entradas vivas |
| 9 | Mira el `Salud` del cliente en el panel | Sin avisos de «cobros sin pedido» ni de pedidos atascados | Que lo anterior no dejó restos |

**Si el paso 3 tarda más de 10 minutos**, mira el panel (`Salud`: «pedidos PENDING con pago de más de N minutos») y la tarea `reconcile-payments`. Con una venta grande el cron examina hasta **100 pedidos por pasada y lista** (variable `RECONCILE_GATEWAY_BATCH` para ajustarlo) y una pasada cada 5 minutos; 400 compradores que cierran la pestaña tardan unas 4 pasadas (≈ 20 min) en recibir sus entradas.

## Recomendación para eventos grandes

**Stripe es la pasarela recomendada** para un evento con mucha demanda: confirma el pago por webhook en segundos y no depende de que el comprador vuelva ni de un cron. Con SumUp, la entrega depende de que el comprador vuelva a la web o de la siguiente pasada del cron (hasta unos minutos, más en un pico). Úsala si el cliente ya la tiene o prefiere su cuenta, y avísale de este límite antes de una venta grande.

## Lo que sí está cubierto por el código

- Todas las llamadas a SumUp tienen **tope de tiempo** (10–15 s). Si SumUp no contesta al crear el checkout, la compra falla limpia (se cancela el pedido y se libera el aforo) en vez de quedarse colgada.
- La cola del cron es **justa**: lo que nunca se examinó va primero; un fallo de SumUp no libera entradas de pedidos que podrían estar pagados (la decisión solo libera con SumUp confirmando que el pago ya no puede llegar).
- Un pago de SumUp sin pedido guardado (el `paymentId` no llegó a grabarse) lo encuentra la conciliación diaria por la referencia del checkout.
