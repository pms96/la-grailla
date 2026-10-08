# M6 · Producto vendible

Que un cliente nuevo tenga **su** web, sus mensajes, su tienda y sus cobros sobre el mismo despliegue, sin heredar nada de La Grailla. Criterio de salida del plan: una web de demo distinta a La Grailla, en el mismo despliegue, con dos plantillas.

## Marca por cliente

Todo lo que antes era «La Grailla» escrito a mano (78 sitios) sale ahora de `getBrand()` (`lib/brand/brand.ts`): web, metadatos, emails, PDFs de entradas y de contabilidad, Excel, pases de wallet, textos legales y la autorización de menores.

| Situación | Marca que se ve |
|---|---|
| Instalación única o cliente `legacy`, **sin** tema guardado | La de La Grailla de siempre y **ningún CSS añadido**. |
| Cliente nuevo, sin tema | **Neutra**: su dominio como nombre, sin logo, paleta sobria y plantilla editorial. Nada de otro cliente. |
| Cualquiera, con tema guardado | El suyo. Los recursos que no tenga (logo…) los hereda solo La Grailla; los demás, vacío. |

### El tema (`site_theme`)

Un JSON en `AppConfig`, validado con zod **al guardar y al leer** (`lib/brand/theme.ts`). Lo que haya en la BD, lo escribiera quien lo escribiera, pasa por el esquema; si no es válido, se ignora y se usa la marca por defecto.

- **Pocas decisiones, derivadas con contraste legible.** El cliente elige color principal, acento y (opcionalmente) el fondo claro y oscuro. De ahí se derivan los 29 tokens de `globals.css` (primer plano, tarjetas, bordes, gráficos…) y el texto sobre cada color se elige entre blanco y una tinta oscura para cumplir WCAG AA. Un tema ilegible no se puede guardar (422) y la pantalla lo avisa en directo.
- **Nada de texto libre en CSS.** `buildThemeCss` solo emite tripletes HSL calculados y nombres de variable de una lista cerrada, y comprueba el resultado con una expresión regular antes de salir. El CSS se inyecta sin capa, así que gana a `@layer base`.
- **Tipografías de un catálogo cerrado** (8 familias con `next/font`, que exige declararlas en el módulo y con argumentos literales). Las dos de La Grailla conservan su precarga; el resto, `preload: false`. Cada familia tiene su variable `--f-*`; un tema solo reasigna `--font-display` y `--font-sans`, sin referencias circulares (hay un test).
- **Recursos** (logo claro/oscuro, favicon, imagen social): `/brand/*` solo para el cliente legacy, o un fichero de Blob **bajo el prefijo del cliente** (`{tenantId}/…`), con el host y la ruta comprobados con `new URL` (no hay subcadenas). Sin logo se muestra el nombre como marca de texto, también en PDFs y wallet.
- **Solo se escribe por `PUT /api/admin/theme`.** El `PUT` genérico de configuración ignora la clave `site_theme`.

### Plantillas

| Plantilla | Carácter |
|---|---|
| `feria` | La portada de La Grailla: degradado, ruido, pegatinas de borde grueso y botones redondeados. |
| `editorial` | Sobria: titular grande, mucho aire, cartel a la derecha, sin adornos. |

Las dos comparten el resto de secciones (programación, tienda, sobre nosotros, patrocinio, contacto), que aparecen según los módulos del cliente.

### Pantalla «Apariencia» (`/admin/apariencia`)

Identidad, plantilla, colores, tipografías, esquinas, modo por defecto y logos, con **vista previa en claro y oscuro** calculada con el mismo código que el servidor. «Restablecer» vuelve a la apariencia por defecto (en La Grailla, la original).

## Núcleo

- **Bandeja de contacto.** Formulario en la portada (`#contacto`) → `POST /api/contact` → `ContactMessage` en la BD del cliente → aviso al `admin_email` **de ese cliente** (si no lo tiene, el mensaje queda en la bandeja y no se envía a ninguna otra dirección). Defensas: límite de 5 por hora y por IP, campo trampa que descarta a los bots en silencio, consentimiento RGPD, tamaños acotados, texto escapado en los emails. Admin en `/admin/mensajes`: filtrar, buscar, leer, **responder por email** (queda guardada; si el email no sale, el intento queda como «no enviada» y el mensaje no pasa a respondido), archivar y eliminar (derecho de supresión).
- **El formulario viene encendido para un cliente nuevo y apagado para La Grailla** (`contact_form_enabled`), que lo activa cuando quiera en Configuración → Contenido.
- **Landing por secciones:** hero, programación (Entradas), tienda (Tienda), sobre nosotros (si hay texto), patrocinio (Sponsors) y contacto. Los textos son editables en Configuración → Contenido y, vacíos, caen a la marca.
- **Usuarios con un solo rol salvo con Entradas:** crear o asignar `TAQUILLA` exige el módulo (la API lo rechaza; la pantalla solo ofrece administrador).
- **Configuración por módulo:** Pagos (Tienda o Entradas), Wallets, Impresora y Seguridad (Entradas), Sponsors y Vídeo IA (Sponsors). El resto es del núcleo.

## Tienda

Dashboard propio (`lib/shop-stats.ts`, `/api/admin/shop-stats`): ingresos, pedidos cobrados, pedidos por enviar, ticket medio, ventas de los últimos 30 días, más vendidos, poco stock y últimos pedidos. **Solo cuenta lo cobrado y no anulado ni devuelto.** El panel de inicio sigue a los módulos: con Entradas es su dashboard de siempre (con la tienda debajo si la tiene), con solo Tienda es éste, y con solo núcleo, marca y mensajes.

## Pagos

`PaymentProvider` ampliado (`lib/payment-adapter.ts`):

- `capabilities`: webhooks, página de pago alojada, reembolsos (parciales, idempotentes) y cobro presencial. Quien usa un proveedor pregunta aquí, no compara nombres.
- `verifyPayment` devuelve un **estado normalizado** (`PAID`, `PENDING`, `FAILED`, `EXPIRED`, `REFUNDED`, `UNKNOWN`) y el importe que dice haber cobrado la pasarela.
- `parseWebhook(rawBody, headers)`: cada proveedor verifica **su** firma y traduce a un evento neutro (`payment_succeeded`, `payment_expired`, `ignored`). Todo lo demás (idempotencia, reconciliación, respuesta) es común en `lib/payments/webhook-handler.ts`.
- **`/api/webhooks/[provider]`** es la entrada genérica. `/api/webhooks/stripe` (la URL ya configurada en cada panel de Stripe) delega en el mismo manejador y se comporta como antes. SumUp no tiene webhook (se reconcilia por cron).
- `createInPersonPayment` queda **declarado** para Tap to Pay; ningún adaptador lo implementa.
- **Reconciliación por módulo:** `lib/reconciliation/{entradas,tienda}.ts`. El webhook decide por el id del pedido y carga solo el módulo que hace falta. Un webhook nunca se corta por fase de licencia ni por módulo apagado.
- El cron libera sin esperar las 24 h los pedidos cuya sesión de pago ya está `EXPIRED` (no se puede pagar). `FAILED` no se libera: en SumUp puede reintentarse.

## Subidas directas a Blob

Las subidas del navegador (vídeos y logos de sponsors) eligen la ruta en el cliente. Ahora el navegador recibe el prefijo de su cliente (`useBrand().blobPrefix`) y **el servidor exige que la ruta lo lleve** tanto al emitir el token como al confirmar la URL. En una instalación única el prefijo es vacío y las rutas son las de siempre.

## Qué cambia para La Grailla (modo normal)

La web pública y las entradas se ven igual. Lo que sí cambia:

- Admin: entradas nuevas **Apariencia** y **Mensajes**; el dashboard muestra la **tienda debajo** del de entradas; Configuración → Contenido tiene campos nuevos.
- Títulos de página iguales (`Eventos | La Grailla`…), pero las **descripciones** de `/eventos`, `/tienda` y `/sponsors` son genéricas con el nombre de la marca.
- El formulario de contacto **no aparece** hasta que lo encienda.
- La cabecera del PDF de autorización de menores usa el morado de los emails (`#a855f7`) en lugar de uno muy próximo.
- El secreto del webhook de Stripe se recorta de espacios (antes un espacio pegado rompía la firma).
- El layout raíz lee `AppConfig` en cada petición (una consulta por petición, compartida con `perRequest`).

## Qué se comprobó

- **Tests:** 858 en la raíz. Nuevos: tema y derivación de colores (contraste AA barrido por todos los tonos, inyección de CSS, URLs de recursos), `resolveBrand`, aislamiento de marca con dos BDs reales (cada cliente su tema, un cliente nuevo sin rastro de La Grailla, valores corruptos en la BD, propiedad de los recursos, el `PUT` genérico no escribe el tema), bandeja de contacto (guardado, aviso al correo del cliente, escape de HTML, honeypot, límite de ritmo, aislamiento, respuesta y fallo de envío, rol de taquilla), dashboard de la tienda, `PaymentProvider` (capacidades, estados, firmas) y el webhook genérico con dos clientes. Con **mutaciones** comprobadas: sin la propiedad del recurso, sin la reserva de la clave `site_theme`, sin el honeypot, sin el límite de ritmo, sin la constancia del email fallido, sin el guard del rol de taquilla, sin la idempotencia del webhook o sin la comprobación de capacidad, los tests fallan.
- **Navegador, front real en modo plataforma** (`a.localhost`, `b.localhost`): dos webs claramente distintas en el mismo despliegue (plantilla editorial clara con Playfair e Inter frente a plantilla feria oscura con Bebas Neue y DM Sans, cada una con su nombre, colores y pegatina); la pantalla de Apariencia con vista previa en vivo y el aviso de contraste; el formulario público → bandeja → detalle; el dashboard de la tienda con datos.
- **Builds de producción** en modo normal y en modo plataforma.
- Un fallo que solo salió al ejecutar: `next/font` no admite `...spread` en sus argumentos (la compilación falla).

## Revisión independiente (agente, 8 oct 2026)

Sin fugas entre clientes ni inyección en CSS (200 000 temas aleatorios, el CSS nunca sale del conjunto de caracteres permitido), con el webhook conservando la semántica anterior. Verificados y arreglados, con test que falla sin el arreglo:

| # | Hallazgo | Arreglo |
|---|---|---|
| 1 (alto) | La Grailla no podía guardar Apariencia: su tema semilla lleva `/icon-32.png` y `/og-image.png`, que el validador rechazaba (400 sin decir cuál). | Esos cuatro ficheros fijos se admiten solo para el cliente legacy; los errores nombran el campo. |
| 2 (medio) | El logo de los PDF podía caer a texto en silencio si `public/brand` no entraba en la función. | Ruta con `public/brand` literal (trazable), respaldo por HTTPS y `console.error` si falla. **Comprobar en Vercel** que las entradas PDF de La Grailla llevan el logo. |
| 3 (medio) | Un logo de Blob se descargaba sin tope y `pdf-lib` descomprime sin límite (bomba de descompresión). | `fetchLimited` (2 MB, 5 s, sin redirecciones) y rechazo de PNG de más de 4096 px leyendo la cabecera IHDR, en PDF y en wallet. |
| 4 (medio) | El formulario de contacto gastaba el cupo antes de validar y no tenía tope por cliente. | Los envíos erróneos no gastan el cupo (tienen el suyo, 30/h) y hay un tope global de 100/h por cliente. |
| 5 (medio) | La liberación temprana por `EXPIRED` del cron no tenía test. | Tests de entradas y tienda (caducado libera; fallido y desconocido no). |
| 7 (bajo) | Primario y acento como texto sobre el fondo podían quedar a menos de 3:1. | Aviso en la pantalla (no bloquea). |
| 8 (bajo) | `/brand/..` pasaba el validador. | Rechazado. |
| 11 (bajo) | Fugas de «La Grailla» a otros clientes: nombre del `.pkpass`, favicon por convención de fichero, enlace del 404. | Nombre neutro, favicon con la inicial sobre el color de marca y enlace de vuelta según módulos. |
| 12 (bajo) | Editar a un usuario de taquilla existente fallaba sin Entradas; el botón de la portada podía apuntar a `#contacto` inexistente; ranking de la tienda con `take: 5000`; días de cambio horario; `blobPrefix` sin contexto; comillas en `From`; `..` en la ruta de subida. | Se permite mantener el rol, el botón desaparece si no hay a dónde llevar, ranking agregado en SQL, cubos por día de calendario, prefijo tolerante, comillas fuera y `..` rechazado. |
| 13 (bajo) | Selector de ficheros de logos admitía SVG/WebP (fallan en PDF y wallet); botones repetidos sin nombre. | Solo PNG/JPEG y nombre accesible por campo. |

**Se deja como está (decisión):** los recursos pueden estar en cualquier almacén Blob siempre que la ruta empiece por `{tenantId}/` (el servidor solo descarga con tope; fijar el almacén de la plataforma llega con el despliegue real); el honeypot podría rellenarse por un gestor de contraseñas (es el compromiso habitual; si aparece, se sustituye por una comprobación de tiempo); las pestañas y el `aria-live` de la bandeja y la gráfica de la tienda (solo `title`) son mejorables; dos consultas más por petición en el layout raíz (se pueden unir en una `findMany`); los cambios de tono de los bloques lila de las entradas de La Grailla (`#f3f0ff` → `#f6f4ff`) y de la cabecera de la autorización de menores.

**Orden de despliegue (importante):** la migración `20261008213000_contact_inbox` debe estar aplicada en **todas** las BD de cliente **antes** de desplegar este código: el formulario de contacto viene encendido para los clientes nuevos y, sin la tabla, `/api/contact` daría 500 y la web mostraría un formulario roto. La Grailla la recibe con `migrate deploy` en su build y parte con el formulario apagado. Hasta el runner de M7, los demás clientes se migran a mano.

## Lo que NO está hecho

- **Más de dos plantillas y tokens avanzados** (el plan decía «1 a 3 plantillas»). Hay dos; la tercera y la sobrescritura de tokens sueltos se añaden cuando un cliente real lo pida.
- **Obligatoriedad de los textos legales y del `admin_email` antes de publicar** (el alta de clientes es de M7): hoy un cliente nuevo ve el texto genérico de las políticas con su nombre hasta que escriba los suyos.
- **Wallets y tarjeta de fidelización** (después de M6, según el plan).
- **`createInPersonPayment`** (Tap to Pay): solo declarado.
- Los errores conocidos fuera de alcance siguen igual: endpoint de reembolso de SumUp, reembolso de la taquilla con tarjeta, `stripe_publishable_key` sin usar y cifrado de `smtp_password` en dos versiones.
