# Runbook de despliegue y marcha atrás

Documento operativo. Se va completando durante la revisión integral (`docs/platform/revision-integral.md`); cada sección cita el hallazgo que la motivó.

## 1. Orden de despliegue

1. **Migrar la BD de cada cliente** con el runner del panel (o `migrate:tenants`), cliente a cliente y fuera de una venta en marcha (el runner se niega a migrar si hay venta en marcha **o si no puede comprobarlo**, H-040; `--force-sales-window` solo para el script y solo si es imprescindible).
2. **Desplegar el front.** `FRONT_MIN_SCHEMA` protege el orden contrario: un cliente cuya BD aún no está migrada ve «en mantenimiento» **solo él**, no el resto.
3. **Desplegar el panel** (no depende del orden con el front: el contrato `ops` es compatible hacia atrás).

Todas las migraciones del repo son aditivas (columna anulable o tabla nueva) y un test (`checkMinSchemaDecisions`) obliga a decidir por escrito si el front las necesita.

## 2. Marcha atrás del front (H-042)

**Regla: una vez migrada la BD de un cliente, el front no vuelve a una versión anterior a P1-16. Se corrige hacia delante.**

Un front anterior a P1-16 contra una BD ya migrada **no da errores** (las migraciones son aditivas), pero **se comporta mal en silencio**:

- No filtra `voidedAt`: los gastos e ingresos **anulados vuelven a sumar** en resúmenes, exports y estadísticas.
- No respeta la temporada cerrada: deja crear, cambiar y borrar en libros presentados.
- Su `DELETE` **borra de verdad** la fila: se pierde justo la trazabilidad que la anulación conserva.
- No escribe en `AdminAuditLog` (reembolsos, cambios de configuración, usuarios, roles quedan sin rastro).

Si hay que dar marcha atrás de verdad:

1. **Apagar el módulo «Contabilidad»** del cliente en el panel mientras dure. Con el módulo apagado las rutas y APIs de contabilidad responden 404 y desaparecen del menú: nadie puede operar con el código antiguo sobre esos datos.
2. Para el resto de módulos, la marcha atrás es segura (solo columnas anulables nuevas; el código antiguo las ignora). Ejemplo: la cola de espera con latido (H-071) sigue funcionando con el front anterior, que no escribe `lastSeenAt`: las filas sin él cuentan como vistas al entrar.
3. Cuando se vuelva a desplegar el front nuevo, reactivar el módulo y **revisar lo que se haya tocado mientras tanto** (los registros creados o borrados con el código antiguo no tienen rastro).

Lo que **no** se debe hacer: restaurar la BD a un punto anterior a la migración para «cuadrar» con el front antiguo sin parar antes las ventas: se perderían pedidos pagados.

## 3. Acciones del propietario antes de desplegar

Cosas que el código **no puede decidir por sí solo** y que hay que mirar en cada cliente:

1. **Migrar** la BD de cada cliente (sección 1). Las dos últimas migraciones añaden un trigger y rellenan datos, no cambian columnas: `20261101110000_backfill_closed_seasons` (rellena `closedAt` de las temporadas ya cerradas, **no** las reabre) y `20261101120000_audit_log_append_only` (ver el punto 4).
2. **Listar las temporadas en `CERRADA`.** Desde el control de cierre (P1-16) una temporada cerrada da 423 al crear, cambiar o anular gastos e ingresos, **y también al mover a ella o desde ella un evento, producto, patrocinio o pedido de tienda** (H-019). Si un cliente tenía temporadas «cerradas» solo de palabra, ahora quedan bloqueadas de verdad: reabrir (solo el propietario, con motivo) las que sigan en uso.
3. **`jornada_corte_hora`**: ponerlo en 6 si el cliente vende de madrugada (la noche de negocio acaba a esa hora, no a medianoche).
4. **Auditoría de solo inserción (H-026).** Tras la migración, la base de datos rechaza cualquier `UPDATE` o `DELETE` sobre `AdminAuditLog` (la aplicación nunca los hacía; ahora tampoco puede un bug ni una consulta a mano). Consecuencias: (a) una política de retención que borre auditoría antigua tiene que hacerlo con `TRUNCATE` o con la salida de emergencia documentada en la propia migración, a propósito y con registro; (b) el borrado completo de un cliente no se ve afectado.
5. **Eventos creados antes del arreglo de zona horaria (H-073).** Los eventos que se crearon a mano **antes** de P0-02 guardaron la hora del formulario como si fuera UTC: se ven con una o dos horas de más (a veces el día siguiente) en la web, el email, el PDF y Wallet. No hay forma de saber cuáles lo están (el instante guardado es válido), así que **no se corrige solo ni se avisa solo**: se lista, en solo lectura, y decide el dueño. Pasos por cliente:
   - `DATABASE_URL=<BD del cliente> npx tsx scripts/listar-eventos-fecha-a-revisar.ts --antes-de=AAAA-MM-DD`, con la fecha en que se desplegó el arreglo en ese cliente.
   - Para cada evento listado, comparar «se ve ahora» con la hora que el organizador sabe que es la correcta. Si ya es la correcta, no hacer nada.
   - Si no lo es: corregir la fecha desde Eventos → editar. Si el evento tiene compradores, el panel pregunta si avisarlos por email del cambio de fecha (409 `date_change_needs_confirmation`): decidir **antes** qué hora vieron ellos (la de sus entradas y emails) y avisar solo si de verdad cambia lo que ellos creen.
6. **`BLOB_PUBLIC_HOST`** (H-067): poner el host exacto del almacén de Blob de la plataforma (`<id>.public.blob.vercel-storage.com`). Con la variable definida, las imágenes de marca, carteles y logos de sponsors solo se aceptan de ese almacén; **sin ella** vale cualquier almacén de Blob (comportamiento de desarrollo).

## 4. Límites de la sala de espera (H-049)

La posición en la cola se calcula con un `count` sobre `WaitingRoomEntry` (estado `WAITING`, vistos hace menos de 2 minutos, `joinedAt` anterior): **cuesta O(N) por sondeo** porque Postgres recorre las entradas de índice que van por delante. El servidor ya espacia los sondeos según la posición (2 s en las 10 primeras, hasta ~20 s pasada la 1 000, con dispersión ±20 %) y el barrido de admisión se limita a uno por segundo y evento por instancia.

Estimación **calculada, no medida**: con N esperando y un sondeo medio de ~15 s, hay del orden de N/15 sondeos por segundo, cada uno recorriendo hasta N entradas. Con unos 2 000 en cola son ~130 sondeos/s; con 10 000, ~670 sondeos/s sobre decenas de miles de entradas de índice cada uno. Postgres lo soporta mientras la cola de **un evento** se mantenga en el orden de unos pocos miles.

- **Umbral de decisión:** si se espera más de ~3 000 personas simultáneas en cola para un evento, **sacar la cola de Postgres (Redis u otro almacén en memoria) antes de esa venta**. No es un cambio que se pueda improvisar durante el lanzamiento.
- **Antes de una venta grande** hay que hacer una prueba de carga contra Vercel + Neon reales (está pendiente; ver Verificación del plan). Hasta entonces, la cifra de arriba es una guía, no una garantía.
- Ajustes sin código: `waitingRoomConcurrentSlots` y `waitingRoomPurchaseWindowSeconds` por evento (límites 1–1 000 y 30–3 600 s) y la variable `WAITING_ROOM_MAX_LIVE_PER_IP` (turnos vivos por IP, 10 por defecto).

## 5. Reentrada y puerta sin conexión (H-077)

- **«Han entrado» es un acumulado de admitidos**, no el aforo real dentro del recinto: quien sale y vuelve no resta ni suma. La interfaz lo rotula así («han entrado · aforo N»).
- **Reentrada:** si alguien ya admitido sale y vuelve, la puerta le da el rojo «YA ENTRÓ». Un **ADMIN** puede autorizar la reentrada desde ese veredicto («Permitir reentrada»): queda en el historial de escaneos como `REENTRY` con quién la autorizó, no sube «han entrado» y no cuenta como rechazo. La taquilla (TAQUILLA) no puede.
- **Sin conexión no hay puerta:** el escáner necesita la red para validar (no hay modo sin conexión; decisión del dueño, límite aceptado). Llevar datos móviles de respaldo en la puerta y un ADMIN presente.

## 6. Auditoría y contabilidad: lo que cambia y los límites (lote 4)

**Lo que notará quien administra**

- **El rastro de auditoría ya no es «mejor esfuerzo».** Usuarios, roles, configuración, eventos, precios de entrada, temporadas, patrocinios y cambios de estado de pedidos de tienda se anotan en la MISMA transacción que el cambio: si no se puede anotar, no queda cambiado (error 500, se repite). Las acciones que mueven dinero fuera de nuestra base de datos (reembolsos) se anotan justo después de hacerse y ANTES de enviar el correo al comprador.
- **Exportar compradores deja rastro** (`export.orders`, `export.attendees`, `export.shop_orders`: quién, cuándo, con qué filtro y cuántas filas, sin los datos). Si no se puede anotar, no se entrega el fichero.
- **Un usuario que registró gastos o ingresos no se puede borrar** (409): su firma desaparecería de esos apuntes. Para quitarle el acceso, cambiarle el rol.
- **Fechas e importes de Contabilidad**, ahora validados: la fecha es `AAAA-MM-DD` (nada de horas ni texto), el importe no puede ir vacío y el IVA va de 0 a 100. Un gasto de un pedido debe ir en la temporada de ese pedido, y un pedido solo se registra una vez.
- **Cerrar una temporada mientras alguien escribe en ella** ya no puede dejar un apunte nuevo en unos libros cerrados: la escritura espera al cierre y recibe 423.
- **«Generar pedidos»** ignora los artículos desactivados (igual que el planificador).

**Límites aceptados (con su motivo)**

- **Cambio horario (H-004).** La jornada se calcula restando el corte en milisegundos reales: en las dos noches de cambio horario del año, el corte efectivo se desplaza 1 h respecto de la hora de pared. Dos noches al año y solo afecta a ventas pegadas a la hora de corte; no cambia ningún importe.
- **Roles restringidos con Contabilidad (H-024).** Pueden editar importes (incluso a 0 o negativos: los abonos son legítimos). El control es el rastro (cada edición guarda el importe anterior), que anular exige propietario y motivo, y el cierre de temporada.
- **Fecha de un ingreso (H-025).** No se acota a las fechas de la temporada (puede haber noches de fin de año que pasan al año siguiente). El control es el cierre de temporada y el rastro de → a.
- **IP de los clientes (H-027).** `getClientIp` confía en cabeceras que solo son fiables detrás de Vercel. Hay que revisarlo en la fase de autoalojado (proxy de confianza configurable).
- **Conservación (H-028).** La auditoría guarda emails de usuarios e IP sin plazo. Como la tabla es de solo inserción (trigger, §3.4), una política de retención solo puede aplicarse con `TRUNCATE` o con la salida de emergencia, y el plazo lo decide el abogado (se añade a los pendientes externos, junto a H-133, H-135, H-142 y H-144). Hoy no hay ninguna.
- **IVA mixto de un pedido a proveedor (H-140, parte).** Si un pedido junta líneas con IVA distinto, el gasto sale con un IVA «efectivo» medio (p. ej. 14,29 %), que aparece así en el Excel y el PDF. Desglosar por tipo exige un gasto por tipo de IVA: decisión de contabilidad con la gestoría (CO-10), no se improvisa aquí.
- **Sin interfaz de navegador verificada:** los diálogos de gastos, ingresos y «gasto desde pedido» (mensajes de importe e IVA vacíos, botón «Registrar como gasto» oculto con la temporada cerrada) están cubiertos por tests de la lógica y de la API; la comprobación en navegador es de la fase 4 (necesita sesión de administrador).

## 7. Fiscal y exportaciones: lo que cambia y los límites (lote 5)

**Lo que notará quien administra**

- **El CSV de ventas se abre bien en Excel español** (H-137): separador `;`, coma decimal, fechas en hora de Madrid y una columna `estado`. Sin filtro de estado exporta TODOS los pedidos (lo mismo que la pantalla con «Todos»), así que salen también los pendientes, cancelados y reembolsados: **para sumar dinero usa `importe_cobrado`** (solo los completados), no `importe`. El CSV de pedidos de tienda trae `total_cobrado` con el mismo criterio (pagado, procesando, enviado y entregado).
- **Exportar más de 5 000 pedidos o 10 000 entradas da un aviso (413) en lugar de cortar en silencio.** Filtra por evento, estado o búsqueda y vuelve a exportar.
- **Cualquier texto cabe en los PDF** (H-139): un concepto o un nombre con emoji, «ł» o saltos de línea ya no tumba la exportación de gastos ni las de compras; lo que el PDF no puede dibujar sale como «?».
- **El teléfono sale tal cual en el CSV de tienda** (H-138), sin apóstrofo y sin espacios: las etiquetas de envío vuelven a leerlo. Lo que no es un teléfono sigue protegido contra fórmulas.
- **La referencia del pedido cambia** (H-136): ahora son los 8 ÚLTIMOS caracteres del id, en mayúsculas, porque los 8 primeros coincidían entre dos pedidos de la misma fracción de segundo. Los justificantes por correo ya llevan la fecha de la compra. El buscador de Ventas y de Pedidos de tienda busca por subcadena del id: encuentra tanto la referencia nueva como las antiguas ya enviadas (que, como antes, pueden coincidir entre dos pedidos).
- **Tienda: el precio que se cobra es el que se ve** (H-132). Si cambia un precio, o se desactiva un producto, mientras el comprador tiene el carrito, no se le cobra: ve el aviso con el total nuevo, el carrito se actualiza y vuelve a pulsar «Pagar». Un cliente antiguo que no manda el total esperado se sigue cobrando al precio vigente.
- **Patrocinios: se registra lo cobrado, no la tarifa** (H-134). La ficha del patrocinio pide el «Importe cobrado (€, con IVA si lo lleva)», precargado con la tarifa del tipo. Sin tipos guardados en Configuración ya no valen los de fábrica (30/50/75 €): hay que teclear el importe. Un patrocinio sin temporada no se puede marcar como pagado (su ingreso no contaría en ninguna parte); una colaboración en especie no lo necesita.
- **Condiciones de venta** (H-143): si no se pueden leer, la página de compra no muestra el formulario (antes lo mostraba sin versión y el servidor aceptaba lo que el comprador no había visto). `/legal/condiciones-*` y `/legal/privacidad` ya no se guardan en la caché del CDN, y una política de privacidad en blanco muestra la de reserva, la misma que se registra.
- **Etiquetas de cifras** (H-133, parte): «Cobrado con IVA − gastos con IVA» (Ingresos), «Cobrado − gastos, con IVA» (dashboard), «Cobrado menos comisión» (Estadísticas). Son las mismas cifras de antes con un nombre que dice lo que son.

**Límites aceptados y decisiones pendientes**

- **Emisor del justificante (H-135).** «Cambiarlo después no reescribe justificantes» solo es cierto para el tipo de IVA (se copia al pedido). La razón social, el NIF, el domicilio y el correo de factura se leen EN VIVO al abrir o reenviar un justificante: un pedido antiguo reenviado tras cambiar de sociedad o corregir el NIF lleva el emisor nuevo con la base y la cuota antiguas. Copiar el emisor al pedido necesita una migración y que la gestoría diga si hace falta: **decisión pendiente (gestoría)**.
- **Margen y balance (H-133).** Resta gastos con IVA a ingresos con IVA incluido: no es ni el beneficio económico ni el fiscal, y los reembolsos desaparecen de las cifras al pasar a REFUNDED (no hay línea de devoluciones). Las etiquetas ya lo dicen; el criterio y la línea de devoluciones los define la gestoría: **pendiente (gestoría)**.
- **Importe de patrocinio con IVA (H-134).** Se registra lo cobrado tal cual; no se separa la base del IVA. «500 € + IVA» cobrados como 605 € cuentan 605. Si la gestoría necesita la base, hará falta un campo de IVA en el patrocinio.
- **Entradas y precio (H-132).** La comisión y los precios se fijan al cargar `/comprar` y el servidor responde con los de ese momento; el hueco de precio cambiado entre la carga y el pago es mucho menor que en la tienda (donde el carrito vive días en el navegador) y no se ha cerrado.
- **Pantalla de confirmación (H-136).** Muestra la referencia nueva pero no la fecha de la compra; la fecha va en el justificante por correo.
- **Textos legales (H-142, H-144).** La prueba de edad y de menores, y los textos por defecto que afirman lo que el código no sabe (hojas de reclamaciones, entrega en 30 días, «los precios incluyen el IVA» sin tipo configurado) requieren abogado: **pendientes externos**, sin cambios en este lote.
- **Sin interfaz de navegador verificada:** la ficha del patrocinio con el campo de importe y el aviso de precio cambiado en el checkout de tienda están cubiertos por tests de API y de lógica, no en navegador (necesitan sesión de administrador y una pasarela de prueba). Van a la fase 4.

## 8. Operación y migraciones: lo que cambia y los límites (lote 6)

**Migración nueva y orden de despliegue.** `20261101130000_operations_indexes_pending_slots` crea la tabla `PendingSlot` (cupo de pedidos pendientes por IP) y ocho índices. El front de este release la necesita: `FRONT_MIN_SCHEMA` sube a ella, así que **hay que migrar la BD de cada cliente ANTES de desplegar el front** (un cliente sin migrar vería «en mantenimiento»; en el proyecto antiguo, que migra en el build, ya ocurre en ese orden). Crear un índice sobre una tabla viva bloquea sus escrituras mientras se construye: con el volumen de un cliente normal son milisegundos, pero **no se migra con una venta en marcha** (el runner ya se niega). La migración es reejecutable (`IF NOT EXISTS`).

**Lo que notará quien administra**

- **Marcar un pedido como pagado a mano** (tienda y entradas) hace lo mismo que un pago confirmado: email al comprador, aviso al vendedor, y cierra antes la sesión de pago abierta (si el comprador pagara después con tarjeta, ya no puede, y no hay cobro duplicado). Si la pasarela dice que lo cobrado no coincide con el pedido, no se marca y se explica (422).
- **Un turno de la sala de espera solo sirve para una compra**, aunque se lancen varias a la vez. Si la compra se rechaza o la pasarela falla, el turno se conserva.
- **La tienda no cobra un pedido distinto del que se ve:** un producto desactivado o borrado mientras se compra da un aviso (409 `product_unavailable`), el carrito lo quita y el comprador vuelve a pulsar «Pagar».
- **Crear un evento o un producto con un nombre repetido (o sin letras) ya funciona:** el enlace es `noche`, `noche-2`… Antes era un error 500 y no se podía crear.
- **La sala de espera se limpia sola de filas abandonadas** (esperas sin actividad y turnos caducados desde hace más de 24 h, con la IP que guardaban).
- **Cancelar un evento:** un aviso que no llegó a enviarse (la función murió o el correo se colgó) ya no consta como enviado, y un pedido que otro camino reembolsó no cuenta como fallo.
- **Pagos y cron:** el cron reserva la cola de la pasada (hasta 54 s de los 60 de la función) para los barridos de emails, avisos de evento, avisos al vendedor y reparación de reembolsos; antes un bucle de pagos lento los dejaba sin tiempo. El reembolso de un pago tardío ya no queda bloqueado 24 h por un primer fallo corregible.
- **El proyecto antiguo migra en el build con tiempos:** la conexión directa lleva `lock_timeout` de 3 s y `statement_timeout` de 5 min. Si una migración no consigue el bloqueo (hay una venta en marcha), falla, el build no sigue y el despliegue no sale: se repite cuando no haya venta. Requiere que `DIRECT_URL` esté definida (si no lo está, se migra sin tiempos, como antes).
- **Salud del panel:** una BD restaurada que quedó por detrás del registro aparece como **bloqueada** («Deriva GRAVE»), con el paso de resincronización en `m7-operacion.md` §4.
- **Revisión de migraciones:** el linter ya avisa de lo que bloquea escrituras (índices sobre tablas existentes, restricciones, rellenos, `DROP INDEX`) y exige `-- allow-lock: <motivo>`. Una prueba comprueba además que `FRONT_MIN_SCHEMA` es verdad: aplica las migraciones solo hasta ella y lee todos los modelos con el esquema actual.

**Límites aceptados y decisiones pendientes**

- **Stock fantasma (H-039).** Si un producto no tenía tallas ni colores cuando se vendió y se le añaden después, cancelar ese pedido repone stock en una variante que no lo reservó. No se arregla sin una columna nueva y su relleno; la mitigación es **no añadir tallas o colores a un producto con pedidos pendientes**, y corregir el stock a mano si ocurre.
- **`ProcessedWebhookEvent` no se purga (H-047).** Las consultas ya no recorren toda la historia (índice por fecha, lecturas por clave primaria), pero la tabla crece con cada pedido. Borrar marcadores cambiaría el estado de entrega de emails que ven los listados, así que no hay purga automática: con el volumen de un cliente normal (unas decenas de filas por pedido) no es un problema; revisarlo si pasa de ~1 millón de filas.
- **Reembolso con pasarela y anulación (H-033).** La anulación sin dinero es atómica; el reembolso con tarjeta sigue en dos pasos (la pasarela está en medio) y lo repara la barredera `repairRefundedOrders`.
- **Pérdida del aviso al comprador con reintento (H-038).** Si el envío del aviso llegó a salir pero la respuesta se perdió (tiempo agotado), se reintenta y el comprador puede recibirlo dos veces: es preferible a no recibirlo.
- **Sin interfaz de navegador verificada:** el aviso de producto no disponible en el checkout y los mensajes del panel (deriva) están cubiertos por tests de API y de lógica, no en navegador. Van a la fase 4.

