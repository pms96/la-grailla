# Cierre de la revisión integral (fase 6)

Documento de cierre de `docs/platform/revision-integral.md` (259 hallazgos, H-001…H-259; el H-259 se registró en el lote 16). Resume el resultado, deja por escrito **por qué** cada riesgo que sigue abierto se acepta y **cuándo** habría que reabrirlo, y reúne en un solo sitio lo que tiene que hacer el propietario. El detalle de cada cambio está en el registro y en `docs/platform/runbook-despliegue.md` (secciones 1 a 16).

## 1. Resultado

| | |
|---|---|
| Hallazgos registrados | 259 (158 de la fase 1; H-159…H-162 en los lotes 10 y 11; H-163…H-167 en la fase 4; H-168…H-258 en la fase 5; H-259 en el lote 16) |
| Hechos (código y prueba) | 226 |
| Documentados (riesgo aceptado con su motivo, §3) | 24 |
| Decisión del propietario (§4) | 1 (H-254, a la espera de la gestoría); decididas el 2026-11-18: H-234 (A, hecho en el lote 18), H-253 (A, pendiente) y la caducidad de enlaces H-212 (B, pendiente); H-259 resuelto |
| Pendientes externos, gestoría o abogado (§5) | 5, más H-135 y H-028 (ya documentados, con su decisión externa) |
| Críticos abiertos | 0 |
| Altos e «Importantes» abiertos | 0 (los 15 altos, el medio-alto y los 6 importantes están hechos) |

Lo que sigue abierto por gravedad: 2 «Medio» (H-133 criterio de IVA y margen, H-179 retención; ambos externos), 2 «Medio-bajo» (H-142, externo; H-234, resuelto en el lote 18) y el resto «Bajo».

Lotes: 1 a 8 (correcciones y pruebas), 9 `3a3dceb`, 10 `242b745`, 11 `e15a16a`, 12 `d7741ca` (con la fase 4), 13 `e4fa53c`, 14 `b77764b`, 15 `335655f` y `749173e`. La fase 5 tuvo dos rondas con seis revisores nuevos cada una (cazadores de regresiones y barridos ciegos); la ronda 2 fue la última.

## 2. Criterio de salida

> Cero hallazgos críticos, altos o importantes abiertos; todo lo demás con destino explícito.

**Cumplido.** Cada fila que no está hecha tiene un estado en el registro: «documentado (fase 6)» (§3), «decisión del dueño (fase 6)» (§4) o «pendiente externo» (§5).

## 3. Riesgos aceptados y cuándo reabrirlos

Todos son «Bajo». Ninguno se ha dejado por no saber arreglarlo: o es un compromiso de diseño con su motivo, o no se ha podido confirmar ni medir, o depende de algo fuera del código.

| ID | Qué pasa | Por qué se acepta y qué lo limita hoy | Reabrir si… |
|---|---|---|---|
| H-190 | El pedido gratuito (0 €) no manda su email al crearse; sale al abrir la confirmación o por el barrido del cron (5 pedidos por pasada cada 5 min). | La confirmación lo dispara en cuanto el comprador la abre. Con una lista gratuita grande y nadie abriendo la confirmación, los emails pueden tardar horas. | Se va a repartir una lista gratuita de cientos de entradas: llamar a `scheduleOrderEmail` al crear el pedido o subir el tamaño de la pasada. |
| H-194 | Con una cuenta TAQUILLA compartida por varias puertas, el mismo QR en otra puerta en menos de 30 s da ámbar («acaba de entrar») en vez de rojo. | Concesión de H-074: evita rechazar a quien reintenta la lectura en la misma puerta. La ventana es de 30 s. | Hay fraude de entradas pasadas entre personas: usuarios TAQUILLA por puerta. |
| H-196 | Las limpiezas de filas de sistema son oportunistas (1 % de las peticiones) y `ProcessedWebhookEvent` no tiene caducidad. | Crecimiento acotado por el tráfico; con el volumen de un cliente normal no es un problema (runbook §8, H-047). | La tabla pasa de ~1 millón de filas. |
| H-199 | El smoke tras desplegar, sin `SMOKE_URLS`, solo avisa y termina en verde sin comprobar nada. | Es una variable del propietario (§6, punto 4): con ella definida comprueba de verdad. | Siempre: definir la variable al dar de alta cada cliente. |
| H-201 | El cerrojo de la cancelación de evento «falla abierto»: ante un fallo de BD se procesa aunque otra pasada esté corriendo. | Mejor solapar que parar una cancelación; los reembolsos son idempotentes y el fallo queda en el log. | Se ven reembolsos duplicados en una cancelación (no debería ocurrir). |
| H-204 | Con la baja de un cliente (pendiente de borrado o borrado) el middleware da 410 también a los webhooks y a los crons. | Es lo correcto para una baja. Si la baja se revierte pasados unos días, Stripe puede haber deshabilitado el endpoint. | Se revierte una baja: comprobar y rehabilitar el endpoint del webhook en Stripe a mano. |
| H-207 | El tiempo máximo del runner mata el proceso de Node pero no el motor de esquema hijo; y el refresco de registros publica en serie sin presupuesto bajo `maxDuration = 120`. | Ninguno está confirmado; Prisma serializa con su propio cerrojo de migración. | Hay más de ~15 clientes (el refresco en serie se quedaría corto) o un runner marca «fallida» una migración que luego aparece aplicada. |
| H-208 | En la web del cliente, los cubos de login por email (30 por 15 min con dos IPs) permiten bloquear a un ADMIN o TAQUILLA desde cualquier IP; `admin/users` pide 8 caracteres (más débil que la política de «poner contraseña») y no hay MFA. | Se resuelve solo en 15 min. El panel del proveedor ya tiene el bloqueo por cuenta e IP (H-170); la web del cliente no. | Un cliente lo sufre antes de un evento, o se exige MFA a los clientes. |
| H-209 | Fuera de Vercel (autoalojado), `getClientIp` y `getBaseUrl` se fían de cabeceras que allí no son de confianza. | En Vercel no es explotable. | **Bloqueante para la fase de autoalojado con licencia**: debe cerrarse antes de venderla así. |
| H-212 | Los enlaces de pedido, tienda y entrada son permanentes e irrevocables (96 bits, van en `?t=`). | Un enlace filtrado da acceso hasta rotar el secreto del cliente. Hay una propuesta de caducidad de tokens en el stash `stash@{0}`, sin decidir (§4). | Decidir el stash (§4) o se filtra un enlace. |
| H-213 | `smtp_password` sigue en claro en `AppConfig`. | Ya planificado en dos releases (primero el lector, luego el escritor); el lector ya está. | El lector lleva desplegado en todos los clientes: activar el escritor. |
| H-249 | Un despliegue del front con esquema nuevo y un runner lento genera un aviso crítico por cliente si dura más de ~10 min. | Es lo que pide H-175 (el cliente está en mantenimiento). Falta medir cuánto tarda de verdad el runner. Migrar antes de desplegar (runbook §1) lo evita. | Se mide el runner en un despliegue real: ajustar el plazo. |
| H-250 | Si el aviso sale pero no se puede borrar la marca «pendiente», la siguiente pasada fallida lo reenvía, y las marcas consumen cupo de avisos por pasada. | Solo ocurre cuando el propio canal de alertas falla; basta arreglar el canal. | El canal de alertas se cae a menudo. |
| H-252 | El campo trampa del formulario de contacto se llama `website`: un autocompletado del navegador que lo rellene hace que el mensaje se descarte con «éxito». | Sin confirmar que ocurra. Arreglo trivial (renombrar el campo). | Un cliente dice que no le llegan mensajes de contacto: candidato a un lote 16. |
| H-255 | Con el registro caído más de 7 días, un cliente bloqueado solo por calendario vuelve a la fase publicada. | Compromiso del plan: ante la duda no se castiga a quien pudo haber pagado. El comentario del código ya lo dice (corregido en esta fase). | Se quiere endurecer: exigiría decidir qué hacer con un cliente que sí pagó mientras el registro estaba caído. |
| H-256 | Diseño de roles del panel: un OPERATOR levanta una revocación de emergencia; un SUPERADMIN que reinicia a otro operador conoce su contraseña temporal; «Publicar» publica todo lo guardado; la cadena de auditoría no tiene ancla externa. | Todo queda en la auditoría; los operadores son de confianza. | Entra un operador de confianza limitada, o hay que demostrar la integridad de la auditoría ante un tercero. |
| H-257 | Varios menores de diseño del panel (anti-replay de snapshots por instancia, el disparador no reclama filas vencidas, cubo de búsquedas de Host global, dominios PENDING sin lápida, `RUN_STALE_MS` sin tope). | Sin confirmar o documentados como diseño asumido; Prisma serializa las migraciones. | Se escala por encima de ~15 clientes (umbral del plan). |
| H-258 | La devolución parcial de H-183 no funciona con SumUp; `mark-paid` lee la temporada fuera de la transacción; con varias líneas sin stock el mensaje nombra la primera por clave de bloqueo. | Límites ya declarados o cosméticos; ventana mínima. | Un cliente reembolsa parcialmente con SumUp. |

## 4. Decisiones del propietario

**H-234. Permiso de un OPERATOR sobre los dominios del panel.** Hoy añadir un dominio, verificarlo por DNS y marcarlo principal solo pide `tenants:write`. La verificación prueba control del dominio, no que sea del cliente: un operador malintencionado podría hacer que el front construya enlaces de email y retornos de pago hacia su dominio.
- **A (recomendada):** reservar «marcar como principal» y el alta de dominio a SUPERADMIN. Cambio pequeño de permisos.
- **D:** aceptarlo mientras todos los operadores sean de confianza.
- **Decisión del dueño (2026-11-18): A. Hecho en el lote 18** (runbook §20).

**H-253. ¿Cómo se corrige una venta equivocada en puerta?** Una venta de taquilla «durante el evento» crea las entradas ya usadas y la app no deja anular un pedido con entradas usadas: un error de cantidad o de método solo se corrige con un ingreso negativo manual, y la caja del día queda inflada.
- **A:** permitir al propietario anular una venta de taquilla de puerta, con motivo y rastro, ajustando caja y aforo.
- **D:** mantener y escribir el procedimiento manual (ingreso negativo con motivo).
- Mi recomendación: D ahora y A cuando haya un caso real, porque A toca aforo y caja a la vez.

**H-254. Reembolsos y ventas posteriores en una temporada ya cerrada.** El cierre bloquea gastos e ingresos pero no congela los ingresos por entradas: un reembolso en un evento de una temporada CERRADA cambia su margen sin avisar (la venta sí es intencionada).
- **A:** bloquear (423) reembolsos de eventos de temporadas cerradas: obliga a reabrir con motivo.
- **D:** aceptar que el margen de una temporada cerrada pueda cambiar, con una línea de devoluciones visible.
- Mi recomendación: esperar al criterio de la gestoría sobre H-133 (margen y devoluciones), porque decide esto también.

**H-259. La rama por defecto de GitHub (`main`) iba 102 commits por detrás de `plataforma`.** Solo se subía `main:plataforma`, así que `origin/main` no tenía `reconcile-gateway.yml` (la conciliación diaria con la pasarela, H-129) ni `post-deploy-smoke.yml`. GitHub solo ejecuta los workflows con `schedule`, y solo deja lanzar a mano los de `workflow_dispatch`, si el fichero está en la rama por defecto.
- **Decisión del dueño (2026-11-18): una sola rama, `main`.** Comprobado que `main` era ancestro de `plataforma` (avance sin fuerza, sin fusión) y que los dos proyectos de Vercel (`la-grailla-platform`, `panel-control`) seguían `plataforma`; el proyecto antiguo `la-grailla` ya no está conectado al repositorio. `ci.yml` pasa a `branches: [main]`.
- **Hecho (2026-11-18):** `main` avanzó a `plataforma` (`d709460`), el dueño puso `main` como Production Branch en `la-grailla-platform` y `panel-control`, y la rama `plataforma` se borró. La rama por defecto de GitHub ya era `main`, así que no hizo falta cambiarla. Desde ahora se empuja solo a `main`.
- Comprobación después: pestaña Actions → deben aparecer «Reconcile gateway (diaria)», «Post-deploy smoke» y «Migrar la BD de control».

**Caducidad de los enlaces de entrada (H-212, `stash@{0}`).** El stash «caducidad de tokens de acceso + aviso de reacceso a entradas» está sin decidir desde hace semanas: aplicarlo, o descartarlo y dejar los enlaces permanentes (§3).

**Otras decisiones abiertas de lotes anteriores:** qué hacer con las ~455 filas de auditoría de pruebas que quedan de antes en la BD de desarrollo (H-013; la suite ya borra las que crea); y si un rol «contable» puede ver los ingresos agregados de entradas y el nombre de la temporada de cada evento (excepciones documentadas en `module-off-zero-data.test.ts`, lote 8).

## 5. Pendientes externos

| Quién | IDs | Qué hay que decidir |
|---|---|---|
| Gestoría | H-133 | Criterio de IVA y margen (el «margen» resta gastos con IVA a ingresos con IVA incluido) y si hace falta una línea de devoluciones. Las etiquetas ya están renombradas (lote 5). |
| Gestoría | H-135 | Justificantes: copiar el emisor (razón social, NIF) al pedido al venderlo, o documentar que lleva el vigente. |
| Abogado | H-142 | Prueba de edad y de menores completa: meter el aviso de edad y el texto de la autorización en lo que se registra al comprar. |
| Abogado | H-144 | Textos por defecto que afirman lo que el código no sabe (IVA incluido, gastos de envío, hojas de reclamaciones, entrega en 30 días). |
| Abogado | H-028, H-179 | Plazo de conservación de la auditoría y política de retención y anonimización (auditoría, escaneos, mensajes de contacto). |
| Abogado | H-251 | El banner de cookies promete analítica que la política dice que no existe. |

## 6. Acciones del propietario, en orden

**Antes de desplegar**
1. **Migrar la BD de cada cliente** con el runner del panel (o `migrate:tenants`), cliente a cliente y fuera de una venta (runbook §1 y §8). `FRONT_MIN_SCHEMA` protege el orden contrario.
2. **Migración del panel `20261102120000_operator_login_buckets`** a la BD de control, **antes** de desplegar el panel (§15). Se puede hacer con el workflow «Migrar la BD de control» (modo «estado» y luego «aplicar»; ver runbook §18, necesita el secreto `CONTROL_DIRECT_URL` y la decisión de H-259) o a mano con `npm run db:migrate`. Los lotes 13, 15 y 16 no traen migraciones.
3. **Revisar cada cliente** (runbook §3): temporadas cerradas que sigan en uso, `jornada_corte_hora`, la retención de la auditoría (ahora de solo inserción), eventos creados antes del arreglo de zona horaria y `BLOB_PUBLIC_HOST` (obligatoria en la plataforma).
4. **Variables y ajustes opcionales pero recomendados:** `HEARTBEAT_URL` y `HEARTBEAT_SNAPSHOTS_URL` (monitor externo del panel), `SMOKE_URLS` (GitHub: añadir la URL de cada cliente al darlo de alta), `DIRECT_URL` (proyecto antiguo: migrar con tiempos), `PLATFORM_ALERT_URL` y `SENTRY_DSN`.

**Al desplegar:** migrar, luego el front y luego el panel (runbook §1).

**Después de desplegar**
- Descargar un pase de Apple Wallet de una entrada de prueba y entrar en el panel (login con MFA, un cliente, Auditoría, Salir) (runbook §13).
- Mirar la Salud del panel: un cliente nuevo sin marca de BD sale degradado con el motivo (H-197).
- Añadir cada cliente nuevo a `SMOKE_URLS`.

**Cuando toque**
- Los saltos mayores de dependencias: Next 16, Sentry y zod 4 (runbook §13).
- Purga de `ProcessedWebhookEvent` si pasa de ~1 millón de filas (runbook §8).
- Stock fantasma (H-039): no añadir tallas o colores a un producto con pedidos pendientes (runbook §8).

## 7. Verificación final y sus límites

Medida sobre el árbol final de la fase 6 (después del lote 15 y del cierre de H-189, H-203, H-206 y H-210):

| Comprobación | Resultado |
|---|---|
| `tsc --noEmit` front y panel | limpio |
| `next lint` | 0 errores (los mismos avisos de siempre de `<img>` y `useEffect`) |
| `check:migrations` y `observability:check` | en verde |
| Suite del front | 307 archivos / 3568 tests en verde (la línea base de la fase 0 tenía 225 / 2629) |
| Suite del panel | 39 archivos / 565 tests en verde (antes 36 / 471) |
| `next build` del front y del panel | compilan, en un directorio temporal (`tsconfig.json` y `next-env.d.ts` intactos) |
| Mutaciones de los lotes 13 a 15 | 72 (71 mueren y 1 equivalente), 69, 42 y 12: todas las no equivalentes mueren |

**Límites de lo medido**
- Los cambios de interfaz se comprobaron por código y funciones puras, no con un lector de pantalla ni con teclado real; la fase 4 sí midió en navegador la maquetación a 375 px y varios flujos, pero no los cambios de los lotes 13 a 15.
- No se completó un reto real de Turnstile ni un pago real de Stripe o SumUp; la cámara del escáner no se probó en un móvil físico.
- No se midió bajo carga el tiempo máximo de las funciones, el plazo de Stripe ni los errores de transacción (P2028).
- Una pasada del lote 14 vio una intermitencia en frío (el primer test de `shop-order-state-rules`, 15 s) que no se ha repetido en las pasadas posteriores. Una ejecución interrumpida deja filas de prueba huérfanas en la BD de desarrollo: se limpian a mano (ocurrió una vez, con la suite colgada).
- La BD de desarrollo conserva temporadas `[TEST]` de ejecuciones anteriores; no afectan a la suite pero conviene purgarlas.

## 8. Cómo se reabre algo

1. Si pasa lo que dice la columna «Reabrir si…» de §3, se abre un hallazgo nuevo en el registro (siguiente número libre) citando el ID de origen, con su prueba en rojo primero.
2. Si una decisión de §4 o §5 cambia el comportamiento, va en un lote nuevo (test en rojo, arreglo, mutaciones, `tsc`, lint, suites y builds), como los lotes 1 a 15.
3. Nada de lo documentado aquí se «arregla en silencio»: el registro y este documento se actualizan en el mismo cambio.
