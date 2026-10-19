# Revisión de módulos, aislamiento de datos y plantillas premium

Fecha: 2026-10-15. Revisión de solo lectura hecha por 7 revisores (uno por módulo, uno de aislamiento transversal y uno de la web pública). **No se ha cambiado código.** Las referencias `fichero:línea` salen de los informes; tres de los hallazgos más graves (marcados con ✔) se comprobaron a mano.

> Lo que NO está verificado: no se ha visto el render de ninguna página (solo código y HTML de las referencias), y las estimaciones de esfuerzo son aproximadas.

---

## 1. Lo más importante (léelo si solo lees esto)

**Seguridad y datos, corregibles en pocos días:**

| # | Hallazgo | Módulo | Esfuerzo |
|---|---|---|---|
| 1 ✔ | `GET /api/events?status=DRAFT` lista los **borradores** a cualquiera, y la API pública devuelve datos internos del evento (`currentCount`, `alertsSent`, `temporadaId`, stock por tipo). `app/api/events/route.ts:14` | Entradas | S |
| 2 ✔ | El portal del sponsor devuelve la fila entera: el sponsor recibe `brandContext` (la investigación privada del admin), errores de email y contadores internos. `app/api/sponsors/portal/[sponsorId]/route.ts:56-62` | Sponsors | S |
| 3 ✔ | `allowSponsorAccess` acepta cualquier sesión de staff, **incluida TAQUILLA**: un taquillero puede editar y subir materiales de cualquier sponsor. `lib/access-token.ts:150-156` | Sponsors | S |
| 4 | Un tipo de entrada **desactivado** se puede comprar llamando a la API (no se comprueba `isActive`, ni en `orders` ni en `taquilla/sale`). | Entradas | S |
| 5 | No se compara el **importe cobrado** con el total del pedido (entradas y tienda): un pedido pasa a pagado solo porque la pasarela diga "pagado". | Entradas, Tienda | S |
| 6 | Precios negativos o cantidades sin límite en la tienda pueden dar pedidos gratis o con total negativo. | Tienda | S |
| 7 | La sesión de un admin **no se puede revocar**: borrarlo o cambiarle la contraseña no corta sus sesiones activas (dura hasta 30 días). `lib/auth.ts:48-56` | Núcleo | M |
| 8 | La generación de vídeo IA puede dejar a un sponsor **bloqueado para siempre** (`isGenerating` sin timeout) y gastando un intento. | Sponsors | S |

### Estado a 2026-10-15 (sin commit): fases A y B hechas

**Fase A completa** (lo de la tabla de abajo, más: máquina de estados de pedidos de tienda y stock que no vuelve si ya se envió, IVA del gasto desde pedido calculado de las líneas y editable). **Fase B completa:**
- Configuración por módulo: cada clave de `AppConfig` declara su módulo dueño (`lib/config-ownership.ts`; un test obliga a declarar las nuevas), el GET solo devuelve y el PUT solo guarda claves de módulos activos y de los módulos del usuario, con validación de valores (400 y no se guarda nada si uno falla). Pantalla en pestañas por módulo + «Conexiones» (correo, IA).
- **Cuenta de cobro propia por módulo**: la tienda usa `shop_*` (y `/api/webhooks/stripe-tienda`). Continuidad: mientras no se guarde `shop_payment_gateway`, la tienda sigue con la cuenta de Entradas (para no cortar una tienda en marcha).
- **Roles por módulo**: predefinidos (Gestor de entradas, de tienda, Contable, de sponsors, Contenido y mensajes) y personalizados con alias (tabla `AccessRole`); solo el propietario gestiona usuarios y roles; middleware, API de configuración y menú los respetan.
- **Sesiones revocables**: cada lectura de sesión se contrasta con la BD (usuario borrado, rol cambiado, `sessionsValidAfter`); cambiar contraseña o rol cierra las sesiones.
- Correo de avisos propio por módulo (`notify_email_*`, con el de administración como respaldo).

**Test genérico «módulo apagado = cero datos»** (`tests/tenant/module-off-zero-data.test.ts`, 2026-10-15): (1) toda tabla de Prisma declara su módulo dueño; (2) para «solo núcleo» y «todo menos cada módulo», llama a todos los GET que el middleware dejaría pasar con y sin los datos de los módulos apagados y exige respuestas idénticas. Al estrenarlo encontró dos fugas reales, ya cerradas: sin Contabilidad, ocho respuestas devolvían `temporadaId` (ahora `withoutSeasonLink`), y sin Entradas los pases de wallet de tickets seguían consultando tickets (ahora 404 uniforme). No cubre páginas (server components) ni escritura (POST/PUT/PATCH/DELETE).

> **AL DESPLEGAR (importante):** hay una migración nueva (`20261015120000_access_roles`) y `FRONT_MIN_SCHEMA` sube a ella. Cada cliente se pone en «mantenimiento» hasta que el panel haga **«Migrar BD»**. Orden: desplegar → «Migrar BD» en La Grailla (la migración es aditiva). Las sesiones que ya existen de propietarios siguen valiendo; las de TAQUILLA también. Si la BD falla al contrastar una sesión, se cae al token (no se deja sin sesión al personal de puerta).
>
> **Para dar cuenta propia a la tienda de La Grailla** (cuando toque): pestaña Tienda → elegir pasarela y pegar sus claves → Guardar. Si es Stripe, crear su endpoint `/api/webhooks/stripe-tienda` y pegar su secreto.

### Estado de la fase A (2026-10-15, sin commit)

| Hecho y con test | Pendiente de la fase A |
|---|---|
| 1 borradores y campos internos de la API de eventos · 2 portal de sponsors con lista cerrada · 3 sponsors solo ADMIN · 4 tipo de entrada desactivado / de otro evento · 5 importe cobrado vs total (entradas y tienda) · 6 límites de precio y cantidad · 8 generación de vídeo IA colgada (se recupera a los 5 min, tiempo límite de 45 s) | 7 revocar sesiones de un admin (requiere columna nueva en `User` y tocar el login: se diseña con la fase B) |
| Cruces: resumen de gastos solo lee Entradas/Sponsors si están activos · ventas por día solo lee la caja si hay Contabilidad · sitemap por módulos · Wallet sin módulo no ofrece pases · el vínculo con la temporada se ignora y se oculta sin Contabilidad (API y 4 pantallas) | Test genérico "módulo apagado = cero datos" para todos los handlers · máquina de estados de pedidos de tienda y no devolver stock de lo ya enviado · IVA fijo del 21 % en gasto desde pedido |

**Aislamiento entre módulos:** el corte por módulo es sólido en las **rutas** (el middleware da 404) pero casi no existe **dentro de los handlers**. Solo hay 3 usos reales de `isModuleEnabled` en el servidor. Detalle en la sección 3.

---

## 2. Revisión módulo a módulo

### 2.1 Núcleo
**Mejoras**
- ALTO: configuración muerta. `social_*`, `cookies_banner_enabled` y `maps_provider` se guardan pero no los lee nadie (el pie no pinta redes; el banner de cookies se renderiza siempre). *(Hallazgo del revisor, sin comprobar por mí.)* → pintarlos o retirar los campos. S
- ALTO: `sitemap.ts` lista `/eventos`, `/tienda`, `/sponsors` y los slugs de eventos **aunque el módulo esté apagado**. S
- ALTO: al guardar Apariencia el CDN sigue sirviendo la marca vieja hasta ~90 s (no hay purga por etiqueta). M
- MEDIO: bandeja sin insignia de "sin responder" en el menú, sin acuse al visitante y con un único `admin_email` para todo (falta `contact_notification_email`). M
- MEDIO: email de usuarios sin normalizar a minúsculas; contraseña solo `min(8)`; el rol `USER` no sirve para nada; `getConfig` traga errores de BD y devuelve el valor por defecto. S/M
- MEDIO: el PUT de config acepta **cualquier clave** y no valida tipos. S
- MEDIO: textos legales como texto plano, con "entradas, pedidos" fijo aunque no haya módulos. M
- MEDIO: subida de imágenes: acepta SVG (el tipo lo da el navegador), sin cuota ni limpieza de huérfanos. S
- BAJO: clave `lagrailla_cookie_consent` con marca fija; fuentes: se declaran 8 familias aunque el cliente use 2.

**Ampliaciones que pedirá un cliente**
- Secciones configurables de la portada (galería, FAQ, mapa y horarios, equipo, testimonios, servicios). **Valor alto, M-L, y es requisito para las plantillas de empresas de servicios.**
- Páginas editables (novedades, "cómo llegar", normas) con editor de texto. L
- Newsletter con consentimiento RGPD. M · Multi-idioma. L · SEO por página y JSON-LD. M
- Banner de cookies real con registro de consentimiento. M · Banner de anuncio / "próximamente". S
- Usuarios con permisos por módulo, 2FA y registro de actividad. M-L

### 2.2 Venta de entradas
**Mejoras**
- Además de los puntos 1, 4 y 5 de arriba:
- ALTO: reembolso **no atómico** (si falla la transacción final queda REFUNDED con entradas VALID); no hay reembolso parcial. M
- ALTO: TAQUILLA puede emitir hasta 20 entradas gratis por llamada sin cupo ni auditoría, y anular invitaciones. M
- ALTO: la sala de espera hace una transacción con lock + un `count` O(n) en cada consulta; con miles de personas compiten por el mismo lock. Mitigación barata: barrer cada N segundos y cachear la posición. L
- MEDIO: el escáner se bloquea 4 s tras cada lectura, no tiene modo offline, y el límite de 120/min es por IP (varias puertas comparten IP). M
- MEDIO: importes en coma flotante sin redondear a céntimos; faltan índices (`Ticket(eventId,status)`, `Order(eventId,status,createdAt)`, `ScanLog(...)`); exportaciones que truncan en silencio y llevan el QR completo; estadísticas por día en UTC y otra en Madrid. S

**Ampliaciones**
- Escáner PWA **offline** con sincronización (la más pedida en campo). M
- Entradas nominativas y cambio de titular. M · Códigos promocionales y apertura de fases por fecha. M
- Zonas con aforo propio (L si numeradas). · Abonos y pases multi-evento. L
- Reembolso parcial. M · Facturas por pedido. M · Lista de espera de agotados. M-L
- Pantalla de puerta con aforo en vivo. S · Pixel de analítica (UTM/Meta/GA). S

### 2.3 Tienda
**Mejoras**
- Además de los puntos 5 y 6 de arriba:
- ALTO: el admin puede poner **cualquier estado** (PENDING→PAID sin cobro). Falta máquina de estados. S/M
- ALTO: reembolsar un pedido ya enviado **devuelve el stock** aunque la mercancía no vuelva. S
- ALTO: productos sin variantes tienen stock ilimitado sin que el admin lo vea. M
- MEDIO: líneas inválidas se descartan en silencio; el carrito se vacía antes de confirmar el pago; el admin guarda stock en valor absoluto y puede pisar reservas; cambiar tallas **borra variantes y su stock**; `GET /api/admin/shop-orders` sin paginar. S/M
- MEDIO: **no hay email de envío** (el correo promete "te avisaremos" y nunca se envía, ni con `trackingNumber`). Es la mayor carencia para el comprador. S/M
- MEDIO: sin envío, IVA ni impuestos. M/L · No existe `/tienda/[slug]` (la ficha es un diálogo, sin URL ni SEO) y el listado es CSR, no rastreable. M
- BAJO: `ShopOrderItem` no guarda el nombre del producto (renombrar cambia el histórico); umbral de poco stock fijo; clave `lagrailla_cart`.

**Ampliaciones:** email de envío con seguimiento (alto, S/M) · gastos de envío y recogida (alto, M) · IVA y facturas PDF (alto, M/L) · cupones (alto, M) · variantes con precio/SKU/imagen (M) · packs (M) · carrito abandonado (M) · avisos de reposición/preventa (M) · tarjeta de fidelización (ver Wallets) · RGPD por interesado (S/M).

### 2.4 Contabilidad
**Mejoras**
- ALTO: el IVA del gasto generado desde un pedido está **fijo al 21 %** aunque las líneas tengan 10 % o 4 %. S/M
- ALTO: redondeo doble por unidad y floats: puede desviarse euros respecto al proveedor. → céntimos enteros o `Decimal`. M
- ALTO: el **margen es incompleto**: suma Entradas y Sponsors pero ignora Tienda, e incluye comisión e IVA (es un margen bruto con IVA, y debe rotularse así). M
- ALTO: una temporada `CERRADA` no bloquea escrituras; el borrado de gastos/ingresos es duro y sin huella de quién cambió qué. S / M
- MEDIO: validación débil (rangos de IVA, existencia de temporada/artículo/proveedor → hoy acaba en error 500); pedidos rígidos (no se editan líneas ni se borra un borrador); el planificador no redondea a unidades por caja y elige la temporada de referencia por año. M
- BAJO: sin paginación; categorías orientadas a bebidas de caseta; `extraer-imagen` envía una URL arbitraria a un tercero (citar en el DPA y validar que sea del Blob propio).
- ✔ La regla "nunca enviar pedidos a proveedores solos" **se cumple** (según el revisor). Conviene un test que la blinde.

**Ampliaciones:** informe P&L por evento/temporada (alto, M) · IVA trimestral y exportación a gestoría (alto, M/L) · adjuntar facturas con OCR (M) · presupuesto frente a real (M) · conciliación bancaria (alto, L) · rol "contable" de solo lectura (M).

### 2.5 Wallets
- ALTO: los pases **no se actualizan ni se anulan** (sin `webServiceURL` en Apple, `state: ACTIVE` fijo en Google): tras un reembolso o cambio de fecha el pase sigue vivo con el QR antiguo. M
- ALTO: la caducidad del certificado de Apple solo se avisa cuando alguien genera un pase. Falta un aviso en el admin. S
- ALTO: Google funciona en modo prueba hasta pedir acceso a producción: va a la guía de alta del cliente. S
- Fuga: `getWalletAvailability()` no comprueba `isModuleEnabled('wallets')`; un cliente con claves residuales sigue enviando pases por email. S
- Hoy Wallets **solo sirve para entradas**. La regla "Entradas o Tienda" no tiene uso real hasta que exista la tarjeta de fidelización. S
- El logo `wallet-strip.png` y el color `#1F1A22` son de La Grailla. Apple exige cuenta de desarrollador (99 $/año por cliente).
- Ampliaciones: pase actualizable/anulable (alto, M-L) · **tarjeta de fidelización** (puntos o sellos, suplemento mensual, L: modelos `LoyaltyCard`/`LoyaltyTxn`, canje en tienda, decidir si el comprador crea cuenta) · pases de abono y notificaciones (M).

### 2.6 Sponsors
- Además de los puntos 2, 3 y 8 de arriba:
- ALTO: el token del portal viaja en la URL (`?t=`), **no caduca** y los de formato v1 siguen vigentes. → caducidad ligada a la edición, `Referrer-Policy: no-referrer`. M
- MEDIO: sin validación del contenido de las subidas (solo el tipo MIME declarado); el meta-prompt tiene una sección duplicada y menciona "festivales, discotecas" fijo; sin recordatorios automáticos ni plantillas de email editables. S/M
- BAJO: sin borrado RGPD por interesado.
- Propuesta de **Sponsors v2**: (1) cerrar las fugas, imprescindible antes de vender; (2) paquetes y acuerdos por evento (`SponsorPackage`, `SponsorDeal`); (3) cobro real con enlace de pago y factura; (4) pipeline con tareas y recordatorios; (5) informe de retorno para el sponsor (vende renovaciones); (6) vídeo IA configurable por tipo de entregable y por cliente.

---

## 3. Aislamiento de datos y configuración por módulo

### 3.1 Qué cruces existen hoy
| Dónde | Qué pasa | Protegido |
|---|---|---|
| `api/admin/gastos/resumen` (Contabilidad) | Lee `Order`/`Event` (Entradas) y `Sponsor` directamente | No |
| `api/admin/stats/ventas-por-dia` (Entradas) | Lee `Ingreso` (Contabilidad) | No |
| `app/sitemap.ts` | Lista rutas y slugs de módulos apagados | No |
| `api/admin/config` GET/PUT | Devuelve y acepta **todas** las claves de todos los módulos; la pantalla solo oculta pestañas | No |
| Entradas, Tienda y Sponsors | Leen y escriben `temporadaId` (Contabilidad) y devuelven `temporada {id,nombre}` | No |
| `admin-dashboard.tsx`, formularios de eventos/productos/pedidos/sponsors | Piden `/compras/temporadas` y pintan el selector aunque Contabilidad esté apagada (falla en silencio) | Solo por el 404 |
| `lib/tickets.ts` | Adjunta pases de Wallet sin mirar si el módulo está activo | No |
| Cron `reconcile-payments` | Mezcla `Order` y `ShopOrder` | Por diseño (dinero en vuelo) |

### 3.2 Reestructurar `/admin/configuracion` por módulo (lo que pediste)
Hoy es una sola pantalla con pestañas cableadas a mano; el input "comisión por entradas" vive en la pestaña común **Pagos**. Propuesta:

| Pestaña | Contenido | Visible si… |
|---|---|---|
| **General** | Contenido, redes, legal, cookies | siempre |
| **Conexiones** (compartidas) | Pasarela de pago y claves, correo (SMTP) y destinatarios, clave de IA | siempre; cada bloque con la etiqueta "Usado por: Entradas, Tienda" |
| **Entradas** | **Comisión por entradas**, límites de compra, seguridad, impresora | módulo Entradas activo |
| **Tienda** | Envíos, IVA, umbral de poco stock, email de pedidos | módulo Tienda activo |
| **Contabilidad** | Categorías, IVA por defecto, temporada activa | módulo Contabilidad activo |
| **Wallets** | Apple y Google | módulo Wallets activo (y Entradas) |
| **Sponsors** | Niveles, textos del portal, vídeo IA | módulo Sponsors activo |

Reglas que lo hacen cumplir de verdad (no solo en pantalla):
1. **Tabla de claves con dueño:** cada clave de `AppConfig` declara a qué módulo(s) pertenece. Una clave compartida (SMTP, pasarela, clave de IA) se declara con **varios dueños** y existe si **cualquiera** está activo; una exclusiva (`commission_percentage`) solo con el suyo.
2. **El GET devuelve y el PUT acepta solo claves de módulos activos**, con validación de tipo por clave.
3. **Destinatarios por módulo** (avisos de sponsors, pagos, contacto) en lugar de un único `admin_email`, con valor por defecto explícito.
4. **Test de CI:** enumera las claves y falla si un handler de un módulo lee claves de otro sin estar declarado.
5. Casos compartidos a mover: la clave de IA (la usan Contabilidad y Sponsors, pero la pestaña solo existe con Sponsors) pasa a **Conexiones**; la **pasarela** la comparten Entradas y Tienda: o se muestra con su etiqueta, o se permite una cuenta por módulo (`shop_active_gateway`…), M.

### 3.3 Entre personas de un mismo cliente
Hoy: ~90 endpoints exigen `role === 'ADMIN'`, TAQUILLA solo entra en escáner/taquilla, y quien administra la tienda también ve las claves de pago y la contabilidad. Propuesta:
- `User.modules: ModuleKey[]` (vacío = todos los del cliente) y `canAccess(sesión, módulo)` comprobado en el middleware (`needsStaff`, usando `ownerOfPath`), en el menú y en los endpoints con dinero.
- Permiso aparte para **Conexiones** (claves de pago y SMTP): solo el propietario.
- Rol "contable" de solo lectura.
- **Riesgo:** toca el JWT. Debe ser aditivo (sin campo = acceso a todo como hoy) para no cerrar la sesión de los admins ni de la taquilla de La Grailla en plena noche de evento.
- Límite honesto: un admin con acceso a un módulo sigue siendo de confianza total en él. Esto protege de errores y de accesos innecesarios, no de un administrador malicioso.

### 3.4 Hacia fuera (público y APIs)
- DTO público explícito (`select`) para eventos y productos: nada de `currentCount`, `alertsSent`, `temporadaId` ni stock exacto.
- Borradores solo para ADMIN.
- Sitemap y navegación filtrados por módulo.
- **Test de CI "módulo apagado = cero datos":** con una BD con filas de todos los módulos, recorrer cada handler con el módulo apagado: 404 en lo suyo e idéntica respuesta a la BD vacía en los handlers que cruzan.

### 3.5 Mecanismos estructurales (orden recomendado)
| Prioridad | Mecanismo | Esfuerzo |
|---|---|---|
| 1 | Test de CI "módulo apagado = cero datos" | M |
| 2 | Corregir los cruces concretos de 3.1 | S cada uno |
| 3 | Config con dueño por clave (3.2) | M |
| 4 | Widgets de dashboard registrados por módulo (`{owner, requires, Component}`) | M |
| 5 | Adaptadores de datos: cada módulo expone `lib/modules/<m>/api.ts` (`getRevenueForSeason`…) y una regla ESLint prohíbe `prisma.<modelo ajeno>` fuera del dueño | M-L |
| 6 | Permisos por módulo y usuario (3.3) | L |
| 7 | Cron de pagos separado por módulo | S |
| 8 | Auditoría de lecturas cruzadas | L (con el panel) |

**Límites que hay que decir al cliente:** los datos de un módulo apagado **siguen en la BD del cliente** (el corte es de aplicación); si se reactiva el módulo vuelven a verse; las tablas `Temporada` y sus claves foráneas cruzan módulos por esquema y solo se cortan del todo con cambios de esquema aditivos.

---

## 4. Plantillas premium

### 4.1 Cómo está hoy
- La plantilla solo cambia **3 cosas**: la portada (un ternario `feria`/`editorial`), la pegatina del nav y la maqueta de Apariencia. Todo lo demás (`/eventos`, ficha de evento, `/sponsors`, nav y footer) es estética feria con **copy fijo** ("PROGRAMACIÓN", "Noches que no se pierden", "Tu marca en la caseta").
- Se parametriza con colores, modo, radio, 2 fuentes de un catálogo de 8, logos y marca. El CSS nunca es texto libre del cliente.
- Límites: imágenes **sin optimizar** (hasta 5 MB), subida solo de imagen (sin vídeo), un único `imageUrl` por evento, `main` con `pt-16` fijo que choca con héroes a sangre, y **ninguna regla `prefers-reduced-motion`** en toda la app.
- Problemas que arreglar antes de nada: `FadeIn` renderiza `opacity:0` en el servidor (el LCP espera a la hidratación); el SVG del grano de `globals.css:195` está malformado (hoy el ruido no funciona); `eventos/loading.tsx` tiene cabecera feria fija.

### 4.2 Qué se toma de las referencias (y qué no)
| Referencia | Se toma | Se descarta |
|---|---|---|
| epic.net | Titular partido por líneas con máscara, reveals | WebGL, SPA, easter eggs |
| unseen.co | Cursor con estados, lista de proyectos con preview al hover | WebGL, audio, pantalla de entrada |
| eszterbial (Varlak) | Tipografía enorme, marquee, bloques de color, vídeo de fondo con póster, cuenta atrás | — (es la más viable) |
| moahu | Bloques de color, producto recortado, microestados ("añadido") | — |

**Técnicas viables:** titulares de 12-22vw con `clamp()`, máscara por líneas en CSS, marquee en CSS puro, reveals con `animation-timeline: view()` (mejora progresiva), `useScroll` de Framer con `LazyMotion`, cursor propio solo con `(hover:hover) and (pointer:fine)`, preview flotante al hover de una fila, cortina de transición y **View Transition** del cartel (lista → ficha) con fallback a fundido.
**Descartadas:** WebGL/Three, audio, pinning pesado con GSAP (duplicaría peso con Framer), Lenis salvo en escritorio y fuera de flujos de compra.

### 4.3 Catálogo propuesto: 6 plantillas, de más a menos material gráfico
Cada una lleva un preset de fuente, radio y modo, y todo su contenido sale de tokens, logo, fotos y textos del cliente.

| Plantilla | Para quién | Material que necesita | Carácter | Momento "wow" |
|---|---|---|---|---|
| **Cine** | Conciertos, promotoras con aftermovie | **Alto** (vídeo + fotos profesionales) | Oscura, vídeo hero a sangre, riel horizontal de eventos con `scroll-snap` | El cartel crece de tarjeta a hero (View Transition) |
| **Galería** | Cultura, gastronomía, clubs privados | Alto-medio | Clara, serif gigante, mucho aire, numeración | Imágenes que se revelan con `clip-path` y parallax suave |
| **Marquesina** | Festivales, ferias, salas y noche | Medio | Oscura, nombre del evento a 18vw, marquee con fecha · lugar · ENTRADAS, bloques de color | Al pasar el ratón por una fila el cartel flota siguiendo el cursor |
| **Drop** | Comercio y marca (tienda) | Medio (producto recortado) | Bloques de color, producto grande, carrusel `scroll-snap` | Microestado "añadido" y producto que sigue al cursor |
| **Estudio** | **Empresas de servicios**, productoras y agencias | Medio | Portafolio de proyectos/casos, lista con preview al hover, servicios y equipo | Lista de proyectos con preview que sigue al cursor |
| **Tipo** | Cualquiera **sin fotos** | **Bajo**: solo tipografía y color | Titulares enormes, formas generativas y bloques de color en lugar de foto | Titular en máscara por líneas y marquee |

**Dependencias que hay que construir para que las plantillas existan:**
- **Estudio** y parte de **Tipo** necesitan que el Núcleo tenga **secciones configurables** (servicios, proyectos/casos, equipo, FAQ). Hoy el núcleo solo tiene hero, "sobre nosotros" y contacto. Sin esto no hay plantilla de empresas de servicios. M-L
- **Drop** necesita `/tienda/[slug]` y el listado de tienda en SSR (hoy es CSR y sin ficha con URL). M
- **Cine** necesita `assets.heroVideo` + póster y que el upload admita mp4/webm (el CSP ya lo permite). M
- Catálogo de fuentes ampliado (p. ej. Anton o Archivo, Instrument Serif o Fraunces, cursiva de Playfair). S
- Sacar a configuración los textos fijos de `eventos/page.tsx` y `sponsors/page.tsx`. S
- Optimización de imágenes al subir (redimensionar y WebP/AVIF) con `fetchpriority` y dimensiones en el hero. M

### 4.4 Reglas de rendimiento y seguridad de la compra
- **Modo "calma"** obligatorio en sala de espera, checkout y confirmaciones: sin cursor, sin cortina, sin Lenis, sin vídeo. Se implementa con un `MotionProvider` y `data-motion` según la ruta. Nuevo campo de tema `motion: 'cinematic' | 'calm'` (enum con default, sin subir `v:1`).
- Hero visible en SSR (keyframes CSS), sin `opacity:0` esperando a la hidratación.
- Animar solo `transform`, `opacity` y `clip-path` pequeño; nada de blur grande ni `backdrop-blur-xl` en capas fijas; vídeo hero ≤ 6 MB.
- `prefers-reduced-motion` global y `scroll-behavior: smooth` condicionado.
- SSR determinista (la caché del CDN va por Host): cuentas atrás y cursor solo en cliente. H1 en HTML real (con `aria-label` si se parte en letras).
- Objetivo medible: Lighthouse móvil con CPU 4× y CLS bajo.

### 4.5 Estado de las plantillas (2026-10-15)

**Marquesina: hecha la primera versión** (portada y `/eventos`). Titular a pantalla completa con máscara por palabras, cinta en movimiento (componente `Marquee`, solo CSS) y programación en filas con el cartel flotando junto al cursor (solo ratón; en táctil, miniatura en cada fila). Todo sale de los tokens y los textos del cliente. Archivos: `app/(public)/_home/marquesina/`, `components/templates/marquesina.css`, `components/ui/marquee.tsx`; la plantilla se elige en Apariencia (con botón «Usar ajustes recomendados»: oscuro, esquinas rectas, Bebas Neue + Space Grotesk). Verificada en navegador (escritorio y móvil) y con 16 tests. Cosas que salieron al verla: la tilde de la Ó/Á se recortaba con la máscara (corregido) y en móvil el titular tenía que ser más grande y partirse en líneas (corregido).

**Pendiente de Marquesina:** la ficha del evento, `/tienda` y `/sponsors` siguen con la estética de Feria (y `eventos/loading.tsx` tiene la cabecera de Feria); la cabecera de navegación es la de siempre; no se ha medido Lighthouse ni CLS; Apariencia no se ha visto en el navegador (necesita sesión de admin); no hay regla global `prefers-reduced-motion` (solo en lo nuevo, porque un reinicio global pararía los indicadores de carga).

**Fechas:** la plantilla formatea en hora de Madrid. Feria y Editorial formatean en la hora del servidor (UTC), así que un evento pasada la medianoche puede salir con el día anterior en esas dos. Convendría unificarlo.

**Tests de componentes:** `vitest.config.mts` transforma JSX con el runtime automático para poder probar componentes con `renderToStaticMarkup`.

**Galería: hecha la primera versión** (portada y `/eventos`). Clara, con **Instrument Serif** (tipografía nueva del catálogo, solo para titulares, con cursiva real: la última palabra del titular va en cursiva solo si el cliente la tiene elegida), cabecera con el nombre del evento, sus datos en una lista con filetes y la foto; programa numerado en el orden del calendario con la foto alternando de lado; las fotos se revelan con `clip-path` y se desplazan con suavidad ligadas al scroll (`animation-timeline: view()`, mejora progresiva: sin soporte o con «reducir movimiento» se ven quietas); sin foto, el día en grande dentro de un bloque tintado. Archivos: `app/(public)/_home/galeria/`, `components/templates/galeria.css`. Es **toda de servidor**: no añade JavaScript al navegador. Verificada en navegador (escritorio y móvil) y con 14 tests.

**Cimientos que salieron de hacer la segunda plantilla:** el modelo de evento ya formateado (`event-view.ts`: `TemplateEvent`, `toTemplateEvent`, `titleSize`) y los tipos de las portadas (`template-props.ts`: `HomeTemplateProps`, `EventosTemplateProps`) son comunes a las plantillas nuevas; el layout público marca la plantilla con `data-template`, que usa una regla global para quitar la sombra de la barra fija en «galería». Cada plantilla nueva es ahora: un CSS, tres componentes y dos ramas pequeñas en `page.tsx` y `eventos/page.tsx`.

**Pendiente de Galería:** igual que Marquesina (ficha del evento, `/tienda`, `/sponsors`, `eventos/loading.tsx` y el menú siguen con la estética de Feria); no se ha medido Lighthouse; no se ha visto Apariencia en el navegador. El parallax solo funciona en navegadores con `animation-timeline` (Chromium; Safari y Firefox ven la foto quieta).

**Tipo: hecha la primera versión** (portada y `/eventos`). Para quien no tiene fotos: bloque de color con el titular enorme (Montserrat 800), cinta invertida (tinta sobre papel), programa en filas con filete grueso de 3 px y bloques de color para tienda, texto propio y patrocinio. En lugar de fotos, **formas geométricas generadas** (`tipo/shapes.ts`, composición tipo Bauhaus en una cuadrícula de n×n): salen del nombre del evento con un generador con semilla (xmur3 + mulberry32), así que son únicas por evento y **idénticas en servidor y navegador y entre peticiones** (sin `Math.random`; la caché del CDN no se rompe). Los colores de las formas son siempre tokens del tema. Con puntero fino la fila se tiñe del acento y la forma gira un cuarto de vuelta. Toda de servidor. Verificada en navegador (escritorio y móvil) y con 21 tests. Cosas que salieron al verla: costuras de antialiasing entre celdas contiguas (se tapan con un trazo de 0,25 del mismo color) y una palabra larga («contemporánea») que se salía de su columna en móvil (ahora se parte con guion y los tamaños de móvil son menores).

**Pendiente de Tipo:** como las otras dos, la ficha del evento, `/tienda`, `/sponsors` y el menú siguen con la estética de Feria (las páginas interiores se resolvieron después, ver más abajo; las secciones de servicios, proyectos, equipo y FAQ también, ver «Secciones de contenido del núcleo»).

**Páginas interiores con la plantilla (2026-10-16).** Antes, un cliente con Marquesina, Galería o Tipo tenía portada propia y, al entrar en un evento, la tienda o patrocinio, volvía a ver Feria (degradado, pegatina y **textos fijos de La Grailla**: «Noches que no se pierden», «Tu marca en la caseta», «PROGRAMACIÓN»). Ahora hay una **cabecera de página común por plantilla** (`app/(public)/_templates/page-banner.tsx`: `PageBanner`, `hasBanner`) y un marco para textos legales (`legal-shell.tsx`). Se usa en la **ficha del evento**, **tienda**, **patrocinio** y las **tres páginas legales**, solo con las plantillas nuevas: **Feria y Editorial conservan su cabecera y el mismo marcado** (comprobado con las páginas de La Grailla en un servidor aislado: mismas marcas, HTTP 200). Todo el texto sale de la configuración del cliente (`home_shop_*`, `home_sponsors_cta_*`); nada fijo de ninguna marca. Los esqueletos de carga (`eventos/loading.tsx`, `[slug]/loading.tsx`) pasan a ser neutros, sin textos ni estilo de Feria (**esto sí cambia para La Grailla**: su estado de carga es más sobrio).
- **Fuera a propósito:** compra, sala de espera, checkout y confirmaciones (modo «calma» del plan: sin adornos de plantilla), el panel y el acceso de personal.
- **Tipografías sin negrita:** Instrument Serif y Bebas Neue solo existen en peso 400. El layout público marca la fuente (`data-display-font`) y una regla global evita la negrita falsa en los títulos de las tarjetas.
- **Palabras largas:** `titleSize(texto, wide)` ahora cuenta la **palabra más larga**, no solo el total de letras («Merchandising» se salía y la máscara la recortaba); «tipo» usa umbrales para tipografía ancha, y sus palabras tienen salida de emergencia (`overflow-wrap`).
- **Sin cambio de datos ni de API.**

**Pendiente tras esto:** el menú y el pie siguen siendo los de siempre (usan tokens, no hay problema funcional); Editorial sigue con la cabecera de Feria en las páginas interiores; las tres plantillas importan sus tres CSS en esas rutas (unos pocos KB extra también para Feria: conviene separarlos si se mide un coste); no se ha medido Lighthouse.

**Secciones de contenido del núcleo (2026-10-16, fase D).** El cliente puede añadir a su portada **servicios, proyectos, equipo y preguntas frecuentes** desde un nuevo apartado del panel, **Secciones** (`/admin/secciones`, del núcleo: no depende de ningún módulo, así que un cliente sin Entradas ni Tienda también las tiene).
- **Sin migración.** Cada sección es un JSON en la configuración (`home_section_servicios|proyectos|equipo|faq`), como los tipos de patrocinio; no hay que pulsar «Migrar BD». Una sección **sin elementos no se muestra**; sin ninguna, la portada es idéntica a la de antes (comprobado con un cliente sin secciones: mismas secciones y mismo menú).
- **Contenido:** título e introducción opcionales y hasta 24 elementos por sección (título, texto, dato corto como «Desde 300 €» o el cargo, imagen subida desde el panel y enlace opcional según la sección). Se ordenan con flechas. Todo el texto es del cliente; los únicos valores fijos son los títulos neutros por defecto («Servicios», «Proyectos», «Equipo», «Preguntas frecuentes»).
- **Seguridad:** `lib/content/sections.ts` (puro) limita longitudes y descarta o rechaza lo peligroso: los enlaces solo pueden ser `https://`, rutas del propio sitio, anclas o `mailto:` (nada de `javascript:`, `data:`, `http:` ni `//otro-sitio`; uno demasiado largo se descarta entero en vez de recortarse a otra dirección); las imágenes solo de Blob. La API de configuración **rechaza con 400** un valor inválido y no guarda nada del envío; el panel avisa antes de enviar y ya no borra un enlace malo en silencio.
- **Plantillas:** `app/(public)/_home/sections/content-sections.tsx` pinta las cuatro con el estilo de cada plantilla (Feria, Editorial, Marquesina, Galería y Tipo). Servicios y proyectos van **antes** de «Sobre nosotros»; equipo y preguntas **después**. Las preguntas usan `<details>` nativo (teclado y lectores de pantalla sin JavaScript, y las respuestas están en el HTML). Si nadie ha subido imágenes, las tarjetas son solo de texto; si hay mezcla, quien no la tiene lleva sus iniciales; en «tipo» siguen las formas generadas. El menú enlaza a las secciones que existan y se **pliega según el número de enlaces** (hasta 4, como siempre; 5-6 por debajo de 1024 px; 7 o más, siempre en el botón de menú): La Grailla, con 3 enlaces, no cambia.
- **Aprovechado:** `ConfigField` ahora asocia la etiqueta a su campo (antes los lectores de pantalla anunciaban un cuadro de texto sin nombre en toda la Configuración).
- **Verificado:** 43 tests nuevos (parseo y límites, enlaces peligrosos, HTML escapado, las cinco plantillas, `<details>`, API con BD y roles, ruta registrada y dueño de las claves); suite completa 152 archivos / 1272 tests; navegador en escritorio y móvil con las cinco plantillas y el editor real (carga, ordenar, rechazo del enlace peligroso, guardado y reflejo en la portada).
- **Pendiente:** las imágenes de Blob no se pudieron ver en el servidor local (solo se admite Blob); no hay vista previa dentro del editor (hay botón «Ver portada»); no hay página propia por proyecto ni por persona; falta la plantilla **Estudio**, que ya tiene sus datos.

**Estudio: hecha la primera versión (2026-10-19).** Plantilla para empresas de servicios, estudios y agencias (portada, `/eventos` y páginas interiores). Se apoya en las secciones del núcleo de arriba.
- **Portada:** el titular es **una frase** (la del cliente: `home_hero_subtitle_1` o el eslogan de la marca; el tamaño se ajusta por longitud total, no por palabra), con su frase de apoyo y el botón de siempre; después, **proyectos** (lo primero que se quiere ver), servicios, «Sobre nosotros», equipo y preguntas frecuentes. Entradas, Tienda y Sponsors, si el cliente los tiene, salen debajo como bloques secundarios («Agenda», enlaces a tienda y patrocinio); un cliente solo con el núcleo no ve nada de eso. Todo el texto es del cliente.
- **Índice de proyectos** (`estudio/project-index.tsx`, cliente): filas grandes con el nombre, el dato corto, la descripción y una flecha si tienen enlace. Con puntero fino, **las demás filas se atenúan, la activa se desplaza y se subraya con el acento, y la imagen del proyecto aparece junto al cursor con un recorte desde arriba**. Es decorativo: en táctil cada fila lleva su miniatura, todo lo importante está en el texto, las imágenes se piden al pasar por su fila y con «reducir movimiento» no hay imagen flotante. Una fila sin enlace es solo texto.
- **Tipografía nueva:** **Bricolage Grotesque** (titulares con peso medio, `lib/brand/fonts.ts`, sin precarga), añadida al catálogo cerrado; preset sugerido: claro, esquinas rectas, Bricolage + Inter. Los temas ya guardados siguen siendo válidos.
- **Resto:** cabecera `BannerEstudio` en ficha del evento, tienda, patrocinio y legales (`hasBanner` ya incluye `estudio`); `ContentSections` gana el estilo `estudio` y el parámetro `kinds` (qué secciones y en qué orden, compatible con `slot`); vista previa en Apariencia; la barra fija pierde la sombra como en Galería y Tipo. Sin migración y sin cambios de datos ni de API.
- **Verificado:** 27 tests nuevos; suite completa 153 archivos / 1299 tests; navegador en escritorio, móvil y modo oscuro (portada, índice con el efecto, servicios, equipo, preguntas, agenda, `/eventos`, ficha de evento y aviso legal). Cosas que salieron al verla: los nombres largos de la agenda se partían en 4 líneas (ahora la agenda usa un título menor y junta lugar, precio y estado en una columna).
- **Pendiente:** las imágenes de Blob no se vieron en el servidor local (en el efecto del cursor se probaron con ilustraciones sustituidas en el navegador); la imagen flotante tapa parte del nombre de la fila que se mira (es lo habitual en este efecto; se puede desplazar más si molesta); no hay página propia por proyecto; Lighthouse sin medir; no se ha visto con un logo subido.

**Cine: hecha la primera versión (2026-10-19).** Plantilla oscura para conciertos y promotoras con vídeo (portada, `/eventos` y páginas interiores).
- **Cabecera con vídeo:** el cliente sube en Apariencia (solo con esta plantilla) un **vídeo MP4 o WebM** y una **imagen de póster**. El vídeo se sube **directo del navegador a Blob** (token de `POST /api/admin/theme/video-upload-token`: solo el administrador, solo la carpeta `{cliente}/brand/hero/`, solo MP4/WebM, máximo 40 MB; el binario no pasa por una función serverless, que tiene un límite de ~4,5 MB). `theme.assets.heroVideo` y `heroPoster` se validan como el resto de recursos (Blob del propio cliente; el vídeo, además, acabado en .mp4 o .webm).
- **Cómo carga:** el póster es una imagen normal con prioridad (lo que cuenta para la carga) y el vídeo **no se pide hasta que el navegador ha pintado**, y solo si procede: no con «reducir movimiento», ni con ahorro de datos, ni en 2G. Se pausa al salir de pantalla y hay siempre un botón **Pausar** (un vídeo que se mueve solo debe poder detenerse). Sin vídeo ni póster, un resplandor del color principal. Al bajar, el vídeo deriva un poco (solo donde el navegador sabe animar con el scroll).
- **Cartelera:** riel horizontal de carteles con `scroll-snap`, región enfocable con nombre, y flechas que solo aparecen cuando funcionan. `/eventos` usa la misma tarjeta en rejilla. Una tarjeta sin cartel muestra el nombre sobre un bloque del color principal.
- **El cartel crece de la tarjeta a la ficha:** View Transition **entre documentos** (`@view-transition` + el mismo `view-transition-name` en la tarjeta y en el cartel de la ficha). Por eso las tarjetas son enlaces `<a>` normales y no los de Next. La regla es global del documento y no se puede acotar con un selector, así que **solo se emite en las páginas de «cine»** (un `<style>` en la propia página): otros clientes nunca la reciben. Sin soporte del navegador o con «reducir movimiento», se navega como siempre.
- **Resto:** estilo `cine` en `ContentSections`, cabecera de páginas interiores (`BannerCine`), vista previa en Apariencia, barra fija sin sombra. Preset sugerido: oscuro, esquinas rectas, Playfair Display + Inter. Sin migración y sin cambios de datos: dos recursos opcionales nuevos dentro del tema (los guardados siguen siendo válidos).
- **Verificado:** 28 tests nuevos; suite completa 155 archivos / 1327 tests; navegador en escritorio y móvil: cabecera con vídeo (reproducción, fundido, botón de pausa), cabecera sin vídeo, cartelera con flechas y encaje, alineación, `/eventos` y entrada en una ficha desde su tarjeta con el mismo nombre de transición en origen y destino.
- **Pendiente:** el efecto de la transición no se puede ver en una captura fija (solo se comprobó que el mecanismo está en las dos páginas); el vídeo real de Blob no se vio en local (se probó con uno servido desde el propio sitio); al cambiar o quitar un vídeo el anterior queda en Blob (como ya pasa con los logos); no se recomprime el vídeo (la guía de Apariencia pide 10-30 s, sin sonido y hasta 40 MB); Lighthouse sin medir.
- **Sobre `scroll-world` (idea anotada del dueño):** se revisó el plugin y **no es un componente que se pueda enchufar a una plantilla**: es una cadena de producción que **genera con IA, y de pago** (Higgsfield o Monid, del orden de 11-27 USD por cadena de 6 escenas), una película por cliente, y exige autenticarse en esos servicios. Encaja como **servicio para un cliente concreto** (una página a medida), no como función de la plantilla. Lo que sí hace Cine es una mínima deriva del vídeo con el scroll.

**Siguientes:** Drop (ver 4.3).

---

## 5. Plan propuesto (orden recomendado)

| Fase | Contenido | Esfuerzo | Notas |
|---|---|---|---|
| **A. Cerrar fugas y huecos** | Puntos 1-8 de la sección 1, los cruces de 3.1, test "módulo apagado = cero datos", sitemap por módulos, gate de Wallets | ~5-7 días | Riesgo bajo, valor alto. **Se despliega en producción (`plataforma`)**: esperar a que acabe la observación del 29 de octubre, o hacerlo en el standby |
| **B. Configuración por módulo y permisos** | Config con dueño por clave, nueva pantalla por pestañas, destinatarios por módulo, permisos por módulo/usuario | ~8-10 días | El cambio de JWT debe ser aditivo (riesgo sesiones de La Grailla) |
| **C. Cimientos de plantillas** | Registro de plantillas, shells por plantilla, copy a config, `data-template`/`data-motion`, primitivas (Reveal, Marquee, SplitLines, cursor), reduced-motion, fix del grano, optimización de imágenes | ~3-4 días | Todo lo demás depende de esto |
| **D. Núcleo: secciones configurables** | Servicios, proyectos, equipo, FAQ, galería | ~6-8 días | Requisito de Estudio y Tipo |
| **E. Plantillas** | Marquesina (5 d) → transiciones/cortina/View Transition (3 d) → Galería (4 d) → Cine (6 d) → Drop (5 d) → Estudio (5 d) → Tipo (3 d) | ~30 días | Orden por valor: Marquesina primero, porque es la que más se parece a lo que ya vendes |
| **F. QA** | Lighthouse móvil, CLS, accesibilidad, previews en Apariencia | ~3 días | |
| **Aparte** | Entradas: escáner offline, nominativas, promociones · Tienda: email de envío, envíos, IVA, cupones · Contabilidad: P&L y gestoría · Wallets: pases actualizables y fidelización · Sponsors v2 | según demanda | Se priorizan con el primer cliente real que lo pida |

Total aproximado del bloque A-F: **55-65 días laborables**. Las plantillas son el grueso.

**Encaje con lo ya planificado:** el ensayo de Next 15 recomienda hacerse en diciembre durante el standby. Conviene hacer **A antes**, y **C-E después** de subir a Next 15 (para no construir animaciones sobre una versión que se va a cambiar; View Transitions y Framer también se verán afectados).

---

## 6. Decisiones pendientes del dueño
1. ¿Se confirma el orden A → B → C-F, o prefieres empezar por las plantillas (lo visible) y dejar las correcciones para el standby?
2. ¿Una cuenta de pago **por módulo** (Entradas y Tienda con cuentas distintas) o la misma pasarela compartida con etiqueta "usado por"?
3. Permisos por módulo: ¿quieres roles con nombre (Propietario, Gestor de tienda, Contable…) o una lista de módulos marcable por usuario?
4. ¿Cuántas plantillas en la primera tanda? Mi propuesta: **Marquesina, Galería y Tipo** (cubren festivales, cultura y quien no tiene fotos), y las otras tres bajo demanda.
5. Para Estudio (servicios): ¿qué secciones necesitan tus primeros clientes de este tipo? (servicios, casos, equipo, precios, reservas, blog…).
