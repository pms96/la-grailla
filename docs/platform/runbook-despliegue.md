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
