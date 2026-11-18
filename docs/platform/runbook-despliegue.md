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
6. **`BLOB_PUBLIC_HOST`** (H-067): poner el host exacto del almacén de Blob de la plataforma (`<id>.public.blob.vercel-storage.com`). Con la variable definida, las imágenes de marca, carteles y logos de sponsors solo se aceptan de ese almacén; **sin ella** vale cualquier almacén de Blob (comportamiento de desarrollo). **En el proyecto de plataforma es obligatoria desde el lote 13 (H-171):** `platform:preflight` falla sin ella (o con una forma incorrecta) y el front lo deja en el log; además ya no la anula `IMAGES_UNOPTIMIZED=1` (esa variable solo decide si Next optimiza las imágenes).

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

## 9. Interfaz y textos: lo que cambia y los límites (lote 7)

No hay migraciones nuevas. Todo es de pantallas, textos y una reserva más en el servidor.

**Lo que notará quien administra o usa la puerta**

- **Puerta (H-085, H-086):** el veredicto se lee a pleno sol y de noche (verde, rojo y amarillo con texto que contrasta) y dice el resultado con palabras; se cierra con el botón «Continuar» o con Escape. «Cerrar sesión» ya no está pegado a «Modo noche»: pide confirmar con «Sí, salir».
- **Cancelar un evento (H-087…H-089):** cerrar el diálogo «sigue en segundo plano» y reabrirlo ya no lanza un segundo bucle; si la carga falla, sale el error con «Reintentar»; y los pedidos «a resolver a mano» traen nombre, email e importe, con un consejo según el motivo (un aviso que no salió dice «avísale tú», no «reembolsa»).
- **Configuración (H-095, H-096):** el navegador ya no rellena las claves secretas con la contraseña del administrador; si la configuración no carga, sale el error (no un formulario vacío) y no hay que guardar nada hasta que cargue.
- **Auditoría (H-097):** cambiar de filtro cancela lo anterior; un error no deja las filas del filtro previo.
- **Confirmaciones del comprador (H-098, H-100):** un pedido reembolsado dice una frase que es verdad siempre; un pedido sin confirmar tras el sondeo dice «NO vuelvas a pagar» y da la referencia, sigue comprobando despacio hasta 10 minutos y deja «Comprobar de nuevo». El checkout avisa si queda un pedido anterior sin confirmar (se recuerda en el navegador un día).
- **Evento cancelado (H-099):** `/comprar` explica que está cancelado; la ficha ya no promete un aviso por email.
- **Correo de relleno (H-101):** la taquilla y las invitaciones guardan `@taquilla.local` / `@invitacion.local` y todo correo `.local` (también los antiguos con el nombre de La Grailla) se ve como «Taquilla (sin correo)» / «Invitación (sin correo)». No se tocan las filas ya guardadas.
- **Reenviar aviso de envío (H-103):** el botón se bloquea mientras envía y el servidor reserva el envío en curso (dos clics seguidos no mandan dos avisos; un reenvío posterior sí se puede forzar).

**Límites aceptados**

- **Sin navegador verificado:** el diálogo de cancelar evento, la configuración, la auditoría, la puerta y el aviso del checkout necesitan una sesión de administrador o de taquilla, o una pasarela de prueba; están cubiertos por pruebas de la lógica pura y de marcado, no en navegador. Van a la fase 4.
- **Pedido pendiente recordado (H-100):** vive en el navegador del comprador (un día): si cambia de dispositivo o borra los datos, no hay aviso. Es una ayuda, no una garantía; la garantía es que el pedido se confirma solo cuando llega el aviso de la pasarela.
- **Texto del evento cancelado (H-099):** no distingue si se avisó o no por email a cada comprador (la ficha pública no lo sabe): por eso no lo promete.

## 10. Pruebas e invariantes: lo que cambia y los límites (lote 8)

No hay migraciones y no cambia nada visible para quien compra o administra. Es casi todo la suite de pruebas.

- **Dos cambios de producción mínimos (H-156):** la ficha del evento y la barra de compra del móvil deciden ahora el botón «Comprar» con una sola función (`lib/event-sale-state.ts`; «cancelado» gana a todo), y el ritmo del sondeo de la cola (`nextPollMs`) vive en `lib/queue-client.ts`. Mismo resultado que antes.
- **La suite ya no pierde configuración real (H-151):** antes de pisar una clave de `AppConfig`, los tests la apuntan en un diario del directorio temporal (`lagrailla-test-config-journal-*.json`, permisos 0600); si una ejecución se aborta, la siguiente (y el final de esta) la restaura y lo avisa por consola. Si ves ese aviso, es que una ejecución anterior murió a medias y ya está reparada.
- **Usuarios de prueba (H-152):** los tests de sponsors borran sus usuarios ADMIN de prueba al acabar; los que quedaban de antes en la BD de desarrollo se borraron en la primera ejecución.
- **Congelación de despliegues (H-153):** hay un test que lee `vercel.json` y el workflow de smoke: quitar `ignoreCommand` o el filtro de producción rompe la CI.
- **Rutas nuevas (H-154):** toda ruta de `app/api` fuera de `/api/admin` tiene que estar clasificada (superficie de personal o lista pública con motivo en `tests/lib/staff-surfaces.test.ts`); si no, la CI falla.

**Límites aceptados**

- Dos excepciones del test «módulo apagado = cero datos» con rol restringido, a decidir por el dueño (ver el registro): el contable ve ingresos agregados de entradas y patrocinio; el rol de entradas ve el nombre de la temporada de cada evento.
- Los tiempos de los tests de cancelación y del cron se midieron sin reloj o con margen amplio, pero siguen usando la BD y `setTimeout` reales: una máquina suspendida a mitad puede dar un fallo aislado (repetir).

## 11. Operación y observabilidad del panel: lo que cambia y los límites (lote 9)

No hay migraciones. Casi todo es del panel (se despliega solo) más un cambio en el front (`/api/health`, el webhook de cobros y `build.js`).

**Lo que notará quien opera**

- **Menos falsas alarmas y menos silencios (H-117, H-118, H-120):** un fallo de lectura del reconcile ya no «recupera» y vuelve a alertar; si el front no puede medir `ops` durante ≈15 min (3 sondeos) sale un aviso «sin poder medir el estado del negocio»; «el reconcile no corre» salta a los 25 min (antes 15, igual que el tope del backoff); las tareas cortas (`health`) ya no se quedan sin ejecutar porque una larga (`reconcile-payments`, 55 s) no cabe.
- **Salud de las migraciones (H-121):** se ve «La última migración NO se aplicó» (venta en marcha o lote parado), una migración «en curso» de más de 30 min, y un ensayo ya no tapa un fallo real anterior.
- **«Migrar BD» dentro de la petición (H-122):** se corta a los 270 s y queda FAILED con la instrucción (revisar `_prisma_migrations`, `prisma migrate resolve` y repetir con `npm run migrate:tenants`, sin tope). Una ejecución abandonada se da por fallida con aviso crítico. **Para un backfill largo usa siempre el script.**
- **Alertas (H-123):** sin ningún canal configurado el aviso queda «pendiente» y sale en cuanto pongas uno; un fallo que sigue ahí se recuerda cada 6 h (la línea de Salud dice «avisado …»); nuevo latido opcional `HEARTBEAT_SNAPSHOTS_URL` (periodo 24 h) para el refresco diario de registros.
- **Cobro sin pedido (H-124):** un cobro, reembolso o disputa de un pedido que no existe en la BD del cliente avisa al operador (correo del cliente + `PLATFORM_ALERT_URL`), un aviso al día por pedido. Sirve para detectar un webhook apuntado al cliente equivocado.
- **Despliegues (H-125, H-127):** `CRON_BUDGET_MS` por debajo de 60 000 se sube a 60 000 (con aviso en el log); `SKIP_MIGRATE_ON_BUILD` acepta true/yes/on y cualquier valor raro salta la migración; una vista previa de Vercel NUNCA migra; `[deploy-anyway]` ya no vale citado en un `Revert`.
- **Preflight (H-128):** `CRON_SECRET` solo se exige con `--legacy`; `PLATFORM_ALERT_URL` y `SENTRY_DSN` salen como aviso ⚠ (no bloquean).
- **GitHub (H-126, H-129):** los workflows de cron corren de uno en uno, con tope de tiempo y sin permisos; `reconcile-gateway.yml` dispara a diario la conciliación con la pasarela fuera del panel (se retira con los otros dos); el smoke tras desplegar comprueba además `/tienda` y `/auth/login`. **Al dar de alta un cliente, añade su URL a `SMOKE_URLS`.**
- **`/api/health` más barato (H-119):** el bloque `ops` se calcula en serie con tope de 2 s por consulta y se reutiliza 30 s por cliente.
- **Logs (H-111, H-130):** `handleApiError` ya no vuelca el error entero (un error de Prisma llevaba nombre y email del comprador); una clave foránea rota al crear/actualizar dice otra cosa y SÍ avisa a Sentry.

**Límites aceptados**

- La caché de 30 s hace que una guarda (módulos, runner de migraciones) pueda ver el bloque `ops` con hasta 30 s de retraso.
- `countEmailBacklog` ya cuenta dentro de la transacción con tope; las consultas de listado del barrido de emails no.
- El smoke no comprueba que sirva el despliegue NUEVO (el `/api/health` público no trae versión) ni cubre la puerta, la cola ni el POST de checkout.
- Sin verificar en navegador: la fila nueva de Salud (latido de registros) y el pill ámbar de migraciones.


## 12. Seguridad general y dependencias: lo que cambia y los límites (lote 10)

No hay migraciones. Cambia el front (`next.config.js`, páginas públicas, formulario de sponsors) y el repositorio (`.gitignore`, `docker-compose.yml`, workflows, dependencias).

**Lo que cambia**

- **Fallo de BD en las páginas públicas (H-104):** `/`, `/eventos`, la ficha de un evento, `/tienda`, `/sponsors` y las páginas legales dan un **500** (lo pinta `app/(public)/error.tsx`, con el mismo menú y pie) en vez de un aviso con 200. El CDN de Vercel solo guarda 200, 301, 302, 307, 308, 404 y 410, así que el fallo ya no se sirve a todos los visitantes 60-90 s después de que la BD vuelva. «Reintentar» recarga con `?_r=…` para saltarse la copia del CDN. Efecto lateral bueno: **una ficha de evento que no existe responde 404 de verdad** (antes 200 con `noindex`, y se guardaba en el CDN). Para que esto siga siendo así, `/eventos` y `/eventos/[slug]` NO deben tener `loading.tsx` (un test lo vigila para cualquier ruta con caché de CDN). Los errores llegan a Sentry por `instrumentation.ts`; en el log queda el motivo redactado, sin la consulta ni los datos del comprador.
- **Sponsors (H-105):** el formulario público acepta como web solo una dirección http(s) (con o sin «https://»), el nombre de contacto no puede llevar enlaces ni direcciones (esa confirmación sale a CUALQUIER email que se escriba), cada email recibe como mucho 3 solicitudes al día y, si el cliente tiene el captcha activado (Turnstile, Configuración → General), el formulario también lo pasa (acción `sponsor`). `escapeHtml` escapa ya las comillas, para todos los correos y PDFs.
- **CSP (H-112):** con `BLOB_PUBLIC_HOST` definida, `img-src`, `media-src` y `connect-src` solo admiten ese almacén de Blob; sin ella (el proyecto antiguo) se mantiene el comodín `*.public.blob.vercel-storage.com`. **Antes de definirla en un proyecto, comprueba que TODAS las imágenes y vídeos suben y se leen de ese almacén** (los de otro almacén dejarían de verse; la app ya los rechaza al guardar desde H-067).
- **Repositorio (H-108, H-109, H-110, H-114):** Postgres de desarrollo solo escucha en `127.0.0.1` (si lo usas desde otra máquina, cambia el puerto a mano); `.gitignore` deja fuera cualquier `.env.<algo>` salvo `.env.example` y los certificados (`*.p12`, `*.pfx`, `*.key`…); 26 dependencias sin uso fuera (`react-is` se queda: es par de recharts); `actions/checkout` y `actions/setup-node` fijadas por SHA y `.github/dependabot.yml` propone cada mes las versiones nuevas (revisar y aceptar esos PR).

**Rotar `NEXTAUTH_SECRET` en un incidente (H-113)** — es una medida fuerte, que corta cosas; úsala solo si el secreto ha podido salir. En modo plataforma el equivalente es `LEGACY_NEXTAUTH_SECRET` (cliente legacy) o `PLATFORM_SESSION_MASTER` / la época de cada cliente (resto).

Qué deja de valer al cambiarlo, todo a la vez:
1. **Todas las sesiones** (admin, taquilla, sponsors con sesión): hay que volver a entrar. No lo hagas durante un evento.
2. **Todos los enlaces con `?t=` ya enviados**: confirmación y PDF de pedidos de entradas y de tienda, entradas, enlace del portal de sponsors. Los compradores los tendrán rotos hasta que se les reenvíen.
3. **Las credenciales cifradas de `AppConfig`** (pasarelas Stripe/SumUp de entradas y tienda, certificado y contraseña de Apple Wallet, cuenta de servicio de Google Wallet, clave de Abacus, clave secreta del captcha): la clave de cifrado sale de ese secreto. Sin volver a escribirlas, esas funciones dan 503 con aviso (no se vacían en silencio).

Pasos:
1. **Antes:** apunta (en tu gestor de contraseñas, no en el repositorio) las credenciales del punto 3, o ten a mano de dónde sacarlas (paneles de Stripe/SumUp, Apple, Google). Elige una hora sin ventas. Si hay una jornada en curso, espera.
2. Genera el nuevo valor (`openssl rand -base64 32`), cámbialo en Vercel (Production, y Preview si la usa) y **redespliega** (las variables solo se aplican con un despliegue nuevo).
3. **Justo después:** entra en `/admin/configuracion` y vuelve a introducir las credenciales del punto 3; en Configuración → Pagos usa «Probar conexión» con cada pasarela.
4. **Reenvía los enlaces** que importen: «Reenviar email» en los pedidos recientes (entradas y tienda) y «Reenviar invitación» a los sponsors con portal activo. Los PDF y confirmaciones antiguos de los compradores dejan de abrirse; avísalos si procede.
5. Comprueba que `/api/health` responde 200 y que un pedido de prueba cobra y manda su correo.
- Rotar solo los enlaces de UN sponsor o de UN pedido NO requiere tocar el secreto: «Regenerar enlace» del portal del sponsor y la versión de token por pedido los invalidan por separado.

**Límites aceptados**

- Marca degradada en el CDN (H-160): con la BD caída, `getBrand()` cae a la marca neutra y las páginas que no leen nada más se guardan con ella 60-90 s. Para el cliente legacy cae a la semilla de La Grailla (la marca correcta); hoy no hay otros clientes en producción. Revisar al dar de alta el primero.
- `/eventos` y la ficha ya no enseñan el esqueleto de carga al navegar entre páginas (hay que quitar `loading.tsx` para que el estado HTTP sea el real); con la copia en el CDN la espera es mínima.
- Las ramas de aviso de error por plantilla (`loadError`) quedaron sin uso; se limpiaron en el lote 11 (H-159).
- Subir el panel de control de Next 14 a 15.5 (H-107) quedó para el lote 11 (§13).

## 13. Panel en Next 15, dependencias y los últimos menores: lo que cambia y los límites (lote 11)

No hay migraciones. Cambia el panel (`apps/control-panel`: Next 15.5.28, `vitest` 4.1.12, `useActionState`), el front (`node-forge`, `passkit-generator`, tope de cuerpo en las compras públicas, copia de condiciones) y las plantillas públicas (código muerto fuera).

**Lo que cambia**

- **Panel en Next 15.5.28 (H-107):** la misma versión que el front, fijada exacta (`apps/control-panel/tests/next-version.test.ts` falla si se separan, si algo usa `cookies()`/`headers()` sin `await` o si una página lee `params`/`searchParams` sin esperarlos). La cookie de sesión del panel conserva nombre y duración: **nadie tiene que volver a entrar** por el despliegue. Tras desplegar el panel: entra, abre un cliente (`/tenants/<id>`), `/audit` y Salud, y comprueba que «Salir» vuelve al login.
- **Compras públicas (H-162):** `/api/orders` y `/api/shop/orders` rechazan con **413** (`payload_too_large`) un cuerpo de más de 32 KB. Un pedido real mide cientos de bytes; solo lo provocaría alguien llamando a la API a mano. No se avisa a Sentry (lo causa el cliente).
- **Wallet y firma (H-161):** `node-forge` 1.4.2 y `passkit-generator` 3.7.0 (con `joi` 17.13.9 forzado en `overrides`). Hay un test que firma un `.pkpass` de verdad con un certificado de prueba. **Tras desplegar, descarga un pase de Apple Wallet de una entrada de prueba** (el test cubre las librerías, no el certificado real del cliente).
- **Condiciones aceptadas (H-054):** la copia de condiciones se vuelve a comprobar cada 10 minutos por versión y un fallo transitorio se reintenta una vez.

**`npm audit`: lo que queda y por qué (H-161)** — se revisa con `npm audit --omit=dev` en la raíz y en `apps/control-panel`. Hoy: front 17 avisos en producción (35 con desarrollo) y panel 3. Ninguno se puede cerrar sin un salto de versión mayor, y ninguno es alcanzable con datos de un atacante:

| Paquete | De dónde viene | Por qué no es alcanzable hoy | Cuándo revisarlo |
|---|---|---|---|
| `postcss` ≤ 8.5.22 | dentro de Next | solo procesa nuestro CSS en el build, nunca CSS ajeno | al subir a Next 16 |
| `glob` / `minimatch` | plugins de build de Sentry; `archiver`/`exceljs` | patrones escritos por nosotros, no por usuarios | al subir Sentry o `exceljs` |
| `zod` 3 | front, panel y `packages/contracts` | en las rutas públicas con arrays ya hay tope de cuerpo (H-162); el resto pide sesión de personal u operador | al migrar a zod 4 (cambio mayor en los tres sitios a la vez) |
| `joi` (vía `passkit-generator`) | firma de pases | valida datos propios; forzada a 17.13.9 | quitar el `override` cuando `passkit-generator` suba su dependencia |

**Límites aceptados**

- **`vatRate` es `Float` (H-056):** los importes son céntimos enteros y `vatBreakdown` redondea una sola vez, así que la imprecisión del `Float` no llega a ningún importe. Cambiarlo a `Decimal(5,2)` exigiría una migración con conversión de filas y tocar todos los lectores, sin beneficio medible.
- **Estado de las reglas del panel en `TenantHealth.error` (H-057):** el texto se corta a 1 200 caracteres. Las líneas de operación van delante, así que el corte se come antes los problemas del sondeo; solo una señal de operación podría perderse con muchas activas a la vez, y se leería como «recuperada» y volvería a avisarse (ruido, no una alerta perdida de golpe). Si se ven avisos repetidos de una misma señal, el estado pasa a una columna JSON propia (migración del panel).
- **Copia de condiciones sin clave foránea (H-054):** con una caída persistente de la BD durante la venta el pedido conserva el hash sin copia, y si las condiciones cambian antes de que se guarde, el texto aceptado ya no se puede reconstruir. Se avisa a operación en cada fallo.
- **El tope de 32 KB solo cubre las dos rutas públicas con arrays** (H-162). No es un sustituto de zod 4.
- **Pendientes externos (sin cambios):** H-133 (criterio de margen y devoluciones, gestoría), H-135 (emisor del justificante, gestoría), H-142 (prueba de edad y menores, abogado), H-144 (textos legales por defecto, abogado) y H-028 (plazo de conservación de la auditoría, abogado).

## 14. Hallazgos «Medio» de la segunda revisión: lo que cambia y los límites (lote 13)

No hay migraciones ni cambios de esquema en el panel. Cambian el front, el panel y `scripts/platform-preflight.ts`. Ver `docs/platform/revision-integral.md` (H-168…H-184).

**Antes de desplegar**

- **`BLOB_PUBLIC_HOST` obligatoria en la plataforma (H-171).** Definirla con el hostname exacto del almacén de Blob (`<id>.public.blob.vercel-storage.com`, sin `https://` ni barras). Sin ella el preflight no deja hacer el corte. Antes de definirla, comprobar que TODAS las imágenes y vídeos se leen de ese almacén (ver §12, CSP).

**Lo que cambia para quien usa la web y el panel**

- **Puerta (H-168):** la búsqueda de asistentes encuentra un pedido por su referencia **completa** (6 caracteres, la que enseña la puerta, u 8, la que lee el comprador), no por un trozo. Por nombre, email completo o QR exacto sigue igual.
- **Configuración (H-173):** «Probar conexión» de las pasarelas es solo del propietario; un rol restringido recibe un 403.
- **Pantallas de contabilidad y ventas (H-176):** gastos, ingresos, ventas, entradas y estadísticas enseñan el error («No se han podido cargar…», con «Reintentar») en lugar de «0,00 €» o una lista vacía. Borrar un evento con pedidos o entradas enseña el motivo y no dice «Evento eliminado».
- **Patrocinios (H-169, H-184):** la web de un sponsor solo admite direcciones http(s) (también desde el portal y el alta manual) y marcar o desmarcar un patrocinio como pagado en una temporada cerrada da 423.
- **Reembolsos (H-183):** si alguien devolvió una parte a mano en Stripe, «Reembolsar» devuelve lo que queda del cobro (antes lo rechazaba la pasarela y el admin veía el error crudo).
- **Auditoría de exportaciones (H-172):** el rastro ya no guarda el texto buscado (solo que hubo búsqueda). Las filas anteriores con un email en el filtro siguen ahí: purgarlas es decisión del abogado (H-179).
- **Panel (H-174, H-175):** una BD de cliente caída, la BD de otro cliente, un front que no sirve o un esquema bloqueante cuentan como fallo de la tarea de salud: aviso **crítico a los 2 sondeos** (10 min) y un único «recuperado». Un aviso crítico que no sale se reintenta en la siguiente pasada fallida (la fila de la tarea muestra « [aviso pendiente]» hasta que sale). Los problemas leves (datos sin completar) siguen siendo un único aviso en el cambio.

**Límites aceptados**

- **`maxDuration = 60` en las rutas de pedido (H-180)** cubre la espera del cerrojo, la transacción y la pasarela; el tiempo límite real de la función en Vercel no se ha medido.
- **Orden de bloqueo (H-181):** reservas, liberaciones y cambios de `soldCount` bloquean siempre en el mismo orden, lo que evita el ciclo; no se ha reproducido el interbloqueo original en un test (es de concurrencia real).
- **Reembolso parcial (H-183):** solo Stripe informa de lo ya devuelto (`refundedAmount`); con SumUp sigue pidiéndose el total.
- **Avisos del panel (H-174):** el estado «aviso pendiente» vive en el texto de `lastError`, no en una columna. Lo que cambia es que ya no se pierde; el resumen «N avisos más» por tope de pasada sigue sin nombrar a los clientes (se reintentan en la siguiente).
- **Pantallas del admin (H-176):** comprobadas por código, no en navegador.
- **Pendientes de decisión (sin cambios):** H-170 (bloqueo del login del panel por cuenta, dueño) y H-179 (retención de la auditoría, abogado).

## 15. Hallazgos de la segunda ronda de la fase 5: lo que cambia y los límites (lote 14)

**HAY una migración nueva del panel** (`apps/control-panel/prisma/migrations/20261102120000_operator_login_buckets`: una tabla nueva, `OperatorLoginBucket`; aditiva, no toca filas ni columnas existentes). El front no tiene migraciones. Ver `docs/platform/revision-integral.md` (H-170 y H-214…H-248).

**Antes de desplegar**

- **Aplicar la migración del panel ANTES de desplegar el panel nuevo** (`npm run db:migrate` dentro de `apps/control-panel`, contra la BD de control). Sin la tabla, el login del panel falla en cuanto el código nuevo intenta reservar un intento. Con la migración aplicada y el panel viejo todavía en marcha no pasa nada (la tabla no se usa).
- Nada más: el front se despliega como siempre. `BLOB_PUBLIC_HOST` sigue siendo obligatoria en la plataforma (§14).

**Lo que cambia para quien compra**

- **Cambiar la selección tras volver de la pasarela (H-214).** Si el comprador va a Stripe, vuelve atrás, cambia las entradas o el carrito y paga otra vez, se le cobra lo NUEVO (antes se le reabría el pedido anterior). Un reintento idéntico tras un fallo de red sigue sin duplicar el cobro. Si el navegador manda una clave vieja con otra selección, el servidor responde «Has cambiado tu selección… vuelve a pulsar Ir a pagar».
- **Precio distinto tras la cola (H-215).** Si el precio o la comisión cambian mientras esperaba, al pagar ve «Los precios han cambiado: el total ahora es X €» y la pantalla se actualiza; no se cobra nada y conserva su turno.
- **Volver desde la pasarela sin pagar (H-219).** El comprador recupera su sitio en la cola (si su turno no ha caducado) y el aviso ya no dice «ya completaste una compra».
- **Confirmación (H-220, H-227, H-229).** Un fallo de red o un 5xx puntual ya no hace creer que el pedido se perdió («Pedido no encontrado»): se conserva lo ya cargado o se ofrece «Reintentar». Un pedido de un evento cancelado dice que el evento se ha cancelado y que las entradas ya no valen. Quien vuelve a `/comprar` con un pedido de ESE evento aún sin confirmar ve un aviso («no repitas la compra») con enlace a su estado.
- **Otros (H-228, H-230, H-231, H-244, H-245).** Un fallo de BD en `/comprar` da el error con reintento (no un 404). Si la cola se activa con la página abierta, el formulario recarga y entra en la sala. El email al comprador y el PDF de autorización de menores salen con tildes (el texto legal por defecto NO se ha tocado). El formulario de entradas envía con Enter y la página imprimible se ve bien en móvil. `/comprar` y el portal de sponsor llevan `noindex`.
- **Pagos (H-217, H-218, H-232).** Crear la sesión de Stripe se corta a los 12 s; la venta de taquilla y las invitaciones esperan el cerrojo del evento lo mismo que el checkout. Con la BD fallando, el cobro propaga el error de BD en vez de decir «modo mock» o «falta la clave», y un pedido ya no puede crearse con comisión 0 por un fallo de lectura.

**Lo que cambia para quien administra**

- **Pantallas del admin (H-221…H-225, H-237, H-248).** Todas enseñan el error con «Reintentar» en vez de listas vacías o ceros (pedidos, productos, usuarios, invitaciones, secciones, aforo, apariencia, noche, escaneos, sponsors, compras, panel de inicio, eventos). Secciones no enseña el editor en blanco si la carga falla (al guardar se habrían pisado las reales). El aviso toma el foco, y un reintento enseña la carga, no «0,00 €». Ventas avisa cuando llega a las 100 más recientes. Una respuesta lenta de la selección anterior ya no pisa la actual.
- **Contabilidad (H-233, H-238, H-246).** Compras rechaza IVA vacío o fuera de 0–100, precios vacíos, negativos o enormes y cantidades negativas (antes quedaban a 0 o se guardaban). El total con IVA de una fila de gastos coincide con la API y el Excel (0,50 al 21 % = 0,61). «Hoy / 7 / 30 días» de Estadísticas se calcula en el servidor con la jornada de Madrid y su hora de corte. Las fechas de una temporada inválidas dan 400, no 500.
- **Sponsors (H-216, H-239, H-242).** El portal ya no escribe la web (un sponsor con una web antigua no válida ya no queda bloqueado al guardar su email y el consentimiento). Rechazar un patrocinio deja auditoría `sponsor.reject` y, si estaba cobrado, avisa de que **sigue contando como ingreso** hasta que se desmarque en «Marcar pago» (no se desmarca solo: la devolución es manual). El alta manual avisa si la web no es válida.

**Lo que cambia en el panel**

- **Bloqueo del login por cuenta e IP (H-170).** El cupo de 5 fallos (15 min) es ahora por (cuenta, IP): quien conozca el email de un operador ya no lo bloquea, solo se bloquea a sí mismo desde su IP. Para no perder la defensa ante una fuerza bruta repartida, la cuenta tiene un tope mayor (30 fallos en total) que sí la bloquea; se levanta con `npm run operator:unlock -- --email …` (que ahora también limpia los cupos por IP). El MFA tiene su propio cupo por IP. Límite honesto: una botnet de más de 6 IPs puede seguir bloqueando una cuenta 15 minutos.
- **Avisos (H-226).** Un solo mal sondeo grave seguido de la vuelta a la normalidad ya no manda un «recuperado» sin aviso previo.
- **Auditoría (H-235).** El alta por asistente deja `tenant.seed` (claves escritas, si se creó el administrador; nunca la contraseña) y añadir un dominio al proyecto de Vercel deja `domain.vercel_add`.
- **Retirar cliente (H-236).** Se hace bajo el candado de publicación de cada suscripción, dentro de una sola transacción: un publicar o el refresco diario no puede reescribir el registro de un cliente que se está retirando.
- **Migraciones (H-247).** La salida de un error de conexión de Prisma ya no enseña el host, el usuario ni la base del cliente a quien tiene `migrations:run`.

**Límites aceptados**

- **Pantallas y formularios (H-220…H-231, H-244, H-245):** verificados por código y por funciones puras, no con un render ni en navegador; el foco del teclado y el «Ir» del móvil no se han probado con dispositivos reales.
- **Tiempos (H-217, H-218):** `maxDuration` y el timeout de Stripe no se han medido en Vercel; el P2028 bajo carga real no se reproduce.
- **Sin hacer (destino D, ver el registro):** el tope de «Todo» en la gráfica de estadísticas, el `anio` no único de temporadas (H-246), los mensajes por campo del formulario de contacto (H-245), todo lo de H-249…H-258 y la decisión de H-234 (dominio principal solo para SUPERADMIN). H-179 sigue siendo del abogado.

## 16. Los «Bajo» de la primera ronda de la fase 5 (lote 15)

**Sin migraciones.** El front y el panel se despliegan como siempre; no hay orden obligatorio, pero conviene desplegar el **front antes que el panel** (el panel ya entiende el campo nuevo de `/api/health`; un panel viejo lo ignora sin problema). Ver `docs/platform/revision-integral.md` (H-185, H-186, H-187, H-188, H-191, H-192, H-193, H-195, H-197, H-198, H-200, H-202, H-205 y H-211).

**Lo que cambia para quien administra**

- **Salud de un cliente (H-197).** Un cliente nuevo cuya BD no tiene la marca `platform_tenant_id`, o cuya marca no se pudo leer, sale **degradado** con el motivo en la ficha («BD sin marca de cliente» / «No se pudo leer la marca»). El cliente legacy sin marca sigue en verde. Si aparece: vuelve a sembrar la BD desde el panel.
- **Latido del disparador (H-198).** Si hay tareas vencidas y no se ejecutó ninguna (presupuesto agotado), el monitor externo recibe el latido de FALLO: antes decía «vivo».
- **«Verificar» un pedido (H-185).** Con un importe cobrado que no cuadra con el pedido responde un error y no anota «verificado»; el pedido sigue pendiente. Revisa el cobro en el panel de la pasarela.
- **Editar un gasto, un ingreso o un pedido de tienda (H-187).** Si otra persona lo anuló o cambió de estado mientras se editaba, sale «recarga y vuelve a intentarlo» (409) en vez de pisar el cambio.
- **Anular un pedido de la tienda (H-188).** Estado y stock se mueven a la vez. **Límite:** el reembolso por pasarela sigue en tres pasos (estado, pasarela, stock); si el proceso muere entre medias el stock no se repone y hay que ajustarlo a mano.
- **Puerta (H-192, H-193).** La referencia antigua de los emails (8 primeros caracteres del pedido) encuentra el pedido; Noche enseña «Reentrada» y «Pedido sin pagar».

**Lo que cambia para quien compra**

- Doble clic en «Pagar» con cola: recibe su pedido, no «Tu turno ha expirado» (H-186).
- El pedido que devuelve la web ya no incluye notas internas ni ids de pago (H-211).
- Los avisos de cancelación de un evento no se duplican con un SMTP lento (H-195).

**Para quien desarrolla:** las limpiezas de tests usan `cleanupWarn` (no `.catch(() => {})`, H-200) y `check:migrations` también marca `CREATE TRIGGER` sobre una tabla viva (H-205).

**Añadido al lote 15 (H-203, H-206, H-210)**

- **Servidor de correo (H-210).** Al guardar la configuración, `smtp_host` solo admite nombres de host públicos o IP públicas (no `localhost`, ni redes privadas, ni `.local`/`.internal`). Si un cliente ya tenía un host interno guardado, sigue funcionando hasta que alguien vuelva a guardar la configuración; en ese momento se le pedirá uno público. No detecta un nombre público que resuelva a una IP interna.
- **Migrar un cliente cuya salud no mide las ventas (H-203).** El panel NO migra si no puede comprobar que no hay una venta en marcha (BD saturada, restaurada por detrás del registro o salud sin la medida): la ejecución queda en «Omitida» con el motivo. Es a propósito. Si es imprescindible (típico tras un PITR, H-043), usa el script desde la carpeta del panel: `npm run migrate:tenants -- --force-sales-window`, y hazlo fuera de una venta.
- **Venta de taquilla duplicada por doble toque (H-206).** Un doble toque con la misma clave devuelve la venta ya registrada (antes, a veces, un error 500). **Sin medir, vigilar si crece el volumen:** la búsqueda del tope de entradas por email recorre las entradas del evento sin índice y la venta de taquilla crea las entradas una a una.

## 17. Cierre de la revisión integral (fase 6)

La lista única y ordenada de lo que tiene que hacer el propietario (antes, durante y después de desplegar, y cuando toque), los riesgos aceptados con su «reabrir si…», las decisiones abiertas con opciones y los pendientes de gestoría y abogado están en **`docs/platform/cierre-revision-integral.md`**. Esta sección solo existe para que quien llegue por el runbook lo encuentre; las secciones 1 a 16 siguen siendo el detalle operativo de cada lote.

## 18. Migrar la BD de control del panel desde GitHub, y el aviso de BD atrasada (lote 16)

El build del panel **no migra** su propia BD de control (solo hace `prisma generate` y `next build`). Hay dos formas de hacerlo; las dos son solo aditivas y se pueden repetir.

**A. Desde GitHub, con un clic (recomendada).** Workflow `.github/workflows/migrate-control-db.yml`, «Migrar la BD de control».
1. **Una sola vez:** en GitHub, Settings → Secrets and variables → Actions → New repository secret: nombre `CONTROL_DIRECT_URL`, valor la URL **directa** de Neon del proyecto `grailla-control` (la que no lleva `-pooler`). Opcional: guardarla como secreto del *environment* `control-db-prod` y exigir ahí un revisor antes de ejecutar.
2. **Que el workflow aparezca en la pestaña Actions:** tiene que estar en la rama por defecto del repositorio, que debe ser `main` (H-259: ya se trabaja solo en `main`; si todavía no cambiaste la rama por defecto en GitHub, mira `docs/platform/cierre-revision-integral.md` §4).
3. Actions → «Migrar la BD de control» → Run workflow → rama `main` → modo **estado**. No cambia nada: dice si la BD de control está al día o qué migraciones faltan.
4. Si faltan: Run workflow otra vez con el modo **aplicar**. Al terminar comprueba que quedó al día y, si no, falla.
5. Despliega el panel nuevo **después** (el orden de §1 y §15 no cambia).

El workflow se niega a ejecutarse (y dice por qué) si no hay secreto, si la URL apunta a una BD local o si es la URL del pooler; nunca imprime la URL (solo el host y el nombre de la base) y no tiene permisos de escritura sobre el repositorio.

**B. A mano** (si prefieres no guardar la URL en GitHub): `npm run db:migrate` dentro de `apps/control-panel` con `CONTROL_DATABASE_URL` y `CONTROL_DIRECT_URL` de producción cargadas en el entorno (`docs/platform/m9-primer-despliegue.md`).

**Qué ves si te olvidas de migrar.** El panel conoce la última migración que espera (`EXPECTED_CONTROL_SCHEMA` en `apps/control-panel/lib/services/control-schema.ts`) y la compara con la BD:
- **Aviso rojo en todas las pantallas del panel, también en la de inicio de sesión:** «Falta aplicar una migración a la base de datos del panel». No nombra migraciones. Desaparece sola en 30 s tras migrar.
- **Latido de FALLO del disparador** (`HEARTBEAT_URL`), además del aviso en el log del disparador: con la BD atrasada el login se rompe y nadie vería el aviso en pantalla, pero el monitor externo sí recibe el fallo.
- **Para quien desarrolla:** al añadir una migración al panel hay que actualizar `EXPECTED_CONTROL_SCHEMA` en el mismo cambio; un test falla si no coincide con la última de `prisma/migrations`.

**Límites:** el workflow no se ha ejecutado nunca contra GitHub (se probó en local la lógica del paso de guardas y los textos de `prisma migrate status`); el panel no tiene un `/api/health` público y no se ha abierto uno; una BD de control **por delante** del panel desplegado no da aviso (otro despliegue más nuevo ya migró).


## 19. CI en verde: reproducirlo en local y qué se arregló (lote 17)

**Qué pasaba.** El CI de GitHub llevaba rojo desde que existe `tests/api/admin-audit-trail.test.ts` (más de 20 commits seguidos) y nadie lo vio, porque la suite local pasaba. El test simula la sesión del admin con un id inventado, así que la regla «no se borra al último administrador» solo ve a los usuarios que haya en la tabla: en una BD de desarrollo siempre hay otros, en la BD vacía del CI el usuario que crea el propio test era el único y la baja devolvía 400. El test ahora crea su propio propietario. Una pasada completa contra una BD vacía (308 ficheros, 3578 tests) no encontró ningún otro fallo de este tipo.

**Un segundo fallo, esta vez intermitente.** Con el CI ya en verde, el commit siguiente falló en `tests/api/order-email.test.ts` («con 8 candidatos y concurrencia 3 nunca hay más de 3 envíos a la vez»: `maxActive` se quedó en 1). El test esperaba solapar envíos con una espera de 25 ms; en un runner lento las consultas a la BD previas al envío tardan más que eso y los envíos no llegan a coincidir. Ahora el envío falso retiene el primer envío hasta que hay 3 a la vez (con un margen de 150 ms por si el tope se rompiera), y el test exige `maxActive` igual a 3. Mutaciones del barrido (concurrencia 1, sin tope, tope 2) detectadas. `tests/api/cron-reconcile-budget.test.ts` mide la concurrencia de la conciliación con 60 ms y `toBe(5)`: mismo riesgo en teoría, sin fallos hasta ahora; si falla en el CI, se arregla igual.

**Regla.** Después de cada `git push`, mirar la pestaña Actions: la suite local usa la BD de desarrollo y esconde los fallos que dependen de datos que solo existen ahí. Un commit no está «verde» hasta que lo está el CI.

**Reproducir el CI en local** (BD vacía, mismas variables que `ci.yml`; no hace falta `psql`):
1. Crear una BD vacía y desechable (`node -e` con Prisma: `CREATE DATABASE lagrailla_ci_repro`).
2. Con `DATABASE_URL` y `DIRECT_URL` apuntando a ella (más `NEXTAUTH_SECRET` y `NEXTAUTH_URL` de `ci.yml`): `npx prisma migrate deploy` y después `npm test`.
3. Al terminar, borrar esa BD (`DROP DATABASE lagrailla_ci_repro`).

**Pendiente de comprobar.** «Cleanup waiting room» fallaba en cada ejecución programada: HTTP 402 (probablemente de Vercel, con `www.lagrailla.es` aún en el proyecto antiguo) y, la última, un fallo de conexión sin respuesta. La URL ya responde 401 sin credenciales. Las ejecuciones programadas de GitHub llegan cada 6-8 horas: la primera con el workflow nuevo, que escribe el código HTTP en una anotación, dirá si quedó resuelto.


## 20. Dominios del panel: solo SUPERADMIN añade y marca el principal (lote 18, H-234)

**Qué cambia.** Añadir un dominio a un cliente y marcarlo como principal decide a dónde apuntan los enlaces de email, de «fija tu contraseña» y los retornos de pago de ese cliente. Verificar por DNS prueba que se controla el dominio, no que sea del cliente, así que con `tenants:write` un OPERATOR podía encadenar alta, verificación y «principal». Ahora ambas cosas exigen el permiso nuevo `domains:manage`, que solo tiene SUPERADMIN (igual que `domains:verify-manual`).

**Quién puede qué.**
| Acción | VIEWER | BILLING | OPERATOR | SUPERADMIN |
|---|---|---|---|---|
| Añadir dominio | no | no | **no** (antes sí) | sí |
| Marcar como principal | no | no | **no** (antes sí) | sí |
| Verificar por DNS | no | no | sí | sí |
| Liberar un dominio que no es el principal | no | no | sí | sí |
| Marcar verificado a mano | no | no | no | sí |

**En la práctica.** Si un OPERATOR necesita un dominio nuevo para un cliente, se lo pide a un SUPERADMIN, que lo añade; el OPERATOR puede entonces verificarlo por DNS. La ficha del cliente ya no enseña «Añadir dominio» ni «Hacer principal» a un OPERATOR, y el servidor lo rechaza aunque alguien lance la acción a mano.

**Límites.** «Liberar» sigue siendo de OPERATOR: no cambia a dónde apunta un cliente (el principal no se puede liberar), pero un dominio liberado deja de servir ese cliente. La creación de un cliente nuevo y el asistente de alta ya eran de SUPERADMIN (`database:write`).


## 21. Los enlaces de pedido y de entrada caducan 30 días después del evento (lote 19, H-212)

**Qué cambia.** El enlace que el comprador recibe por email (`?t=`) abría su pedido, su PDF y sus pases de Wallet para siempre: un enlace filtrado (captura de pantalla, historial de un móvil compartido, un log con la URL) daba acceso a los QR reales y a sus datos. Ahora, pasados **30 días desde la fecha del evento** (`ORDER_LINK_GRACE_DAYS`, en `lib/access-token.ts`), el enlace deja de abrir el pedido, el PDF de entradas y los pases de Apple y Google Wallet: responden 410 «Este enlace ha caducado» y la pantalla de confirmación dice que puede que el enlace haya caducado.

**Vale también para los enlaces ya enviados.** La caducidad se mira al abrir el enlace, mirando la fecha del evento del pedido; el token no cambia de formato. No hay que reemitir nada ni hay enlaces «de antes» que se libren.

**Qué no cambia.**
- El personal con sesión (ADMIN o TAQUILLA, según el caso) sigue pudiendo abrir cualquier pedido, caducado o no.
- Los enlaces de **tienda** siguen siendo permanentes (no tienen evento) y los de **sponsors** también (ya se pueden revocar a mano subiendo la versión del portal).
- Antes del evento y durante los 30 días siguientes todo funciona igual.
- Quien no trae un token válido recibe el 401 de siempre: solo quien tiene un enlace auténtico se entera de que caducó.

**Qué hacer si un comprador pide su entrada pasado el plazo.** Un administrador con sesión abre el pedido desde el panel de administración y descarga el PDF para enviárselo él mismo. El botón de reenviar el email no sirve en este caso: el correo llevaría el mismo enlace, ya caducado.

**Para cambiar el plazo.** Una sola constante (`ORDER_LINK_GRACE_DAYS`); los tests miden el límite exacto a los 30 días.

**Límites.** La fecha que cuenta es la de inicio del evento (`Event.date`), sin tener en cuenta la hora de fin: un evento nocturno tiene 30 días y unas horas. Un evento aplazado a una fecha posterior alarga el plazo con él. No se ha recuperado el aviso al comprador en cada reacceso que traía el stash: mandaba un email por cada reapertura (también el día del evento) y tenía el correo de La Grailla fijado en el código; si se quiere un aviso de accesos sospechosos, es un lote aparte y por cliente.


## 22. Anular una venta de taquilla de puerta (lote 20, H-253)

**El problema.** Una venta de taquilla «durante el evento» crea las entradas ya **usadas**, y «Cancelar pedido» no anula un pedido con entradas usadas. Un error de cantidad o de método de pago solo se corregía con un ingreso negativo manual, y la caja del día quedaba inflada.

**Qué hay ahora.** En Administración → Ventas, al abrir una venta de taquilla de puerta aparece **«Anular venta de puerta»**. Pide un motivo obligatorio (5 a 300 caracteres) y, al confirmar, en una sola operación:
- el pedido pasa a **cancelado** y sus entradas quedan **anuladas** (el QR deja de valer);
- baja lo **vendido** del tipo de entrada;
- baja el **aforo en puerta** tantas personas como entradas estuvieran usadas (nunca por debajo de cero);
- la venta **deja de contar** en la caja del día, en ventas por día y en estadísticas;
- queda en la auditoría («Venta de puerta anulada»): quién, cuándo y el motivo.

**Quién.** Solo el **propietario** (administrador sin rol restringido). Un administrador con un rol como «Contable», la taquilla y el personal no ven el botón y el servidor lo rechaza (403).

**Cuándo se puede.** Venta de **taquilla**, completada, **sin pasarela de pago** y con **al menos una entrada usada**. Si no se cumple el servidor responde:
- venta online, o de taquilla sin entradas usadas → 422 (para una venta sin usar se sigue usando «Cancelar pedido»);
- pagada por una pasarela → 422 (hay que **reembolsarla**);
- ya anulada → 409;
- **temporada cerrada → 423.** Anular cambia el margen de una temporada ya presentada, como anular un ingreso: el propietario puede reabrirla indicando el motivo y volver a intentarlo.

**Procedimientos.**
- *Cantidad o método de pago equivocados:* se anula la venta (con el motivo) y se **vuelve a vender** bien. No hay anulación parcial. Al anular baja el aforo en puerta, así que la nueva venta cabe.
- *El dinero:* la app **no devuelve dinero**. Si se cobró en efectivo o con datáfono, se devuelve en caja y el motivo debe dejar claro qué pasó, para que el cuadre cuadre.
- *El ingreso negativo manual* (el procedimiento antiguo) ya no hace falta; si se hizo alguna vez para una venta que ahora se anula, hay que **no** duplicarlo.

**Garantías.** Dos anulaciones a la vez aplican solo una (la otra recibe 409). La anulación toma el mismo cerrojo por evento que la venta de taquilla, así que una venta y una anulación simultáneas no leen aforo ni stock obsoletos. Si el rastro no se pudo escribir, no se anula nada: todo va en la misma transacción. Con la licencia vencida sigue permitida (es dinero ya cobrado, como cancelar o reembolsar).

**Límites.** No toca el email ni los avisos ya enviados al comprador (las ventas de puerta no llevan email real). No revierte los escaneos que ya constan en el registro de entradas: se conservan como historial. Los pedidos de tienda y los de pasarela no pasan por aquí.
