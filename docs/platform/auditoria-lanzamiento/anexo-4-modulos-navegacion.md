# Auditoría 04 — Coherencia modular, navegación del admin y aislamiento por módulo

Repo: `/Users/pablomunoz/Documents/la-grailla` (rama `main`, árbol limpio al inicio). Auditoría de SOLO LECTURA: no se ha editado, ejecutado ni consultado nada (ni tests, ni BD, ni red). Todo lo marcado VERIFICADO sale de leer el fichero citado; PROBABLE = deducido del código pero no renderizado; HIPÓTESIS = sin comprobar.

Leído: `docs/platform/revision-modulos-y-plantillas.md`, `m5-modulos-licencia.md`, `lib/modules/*`, `lib/tenant/{middleware,resolve,context}.ts`, `middleware.ts`, `app/admin/**` (shell, dashboards, configuración, usuarios), `app/(public)/**` (layout, nav, footer, páginas), `app/api/**` (handlers con sesión, dinero, cron, wallet), `lib/config-ownership.ts`, `lib/access-roles.ts`, `packages/contracts/src/*`, `apps/control-panel/{lib/services,app/actions,vercel.json,prisma}`, tests de `tests/tenant/*` y `tests/lib/module-registry.test.ts`.

---

## 0. Resumen ejecutivo

La base es sólida: registro default-deny testeado, allowlist de dinero en vuelo, fases de licencia, config con dueño por clave, test genérico «módulo apagado = cero datos» para GET. Lo que falla está en **las capas que el registro no gobierna**: textos y plantillas heredadas de La Grailla visibles al público de otros clientes, dashboards y selectores que ignoran los permisos del usuario, rutas de staff fuera de `/admin` que ignoran el rol por módulos, y estados de licencia con callejones sin salida. No existe ningún sistema de feature flags (ni Harness FFM ni otro); el mecanismo real es «lista de módulos en un snapshot firmado».

Tabla de hallazgos P0/P1 (detalle en la sección 3):

| ID | Prio | Hallazgo | Esf. | Confianza |
|---|---|---|---|---|
| MO-01 | P0 | Textos/estética de La Grailla visibles a compradores de otros clientes (`¡Nos vemos en la caseta! 🍻`, `/eventos` con la plantilla por defecto, `/sponsors` en Feria) | S | VERIFICADO |
| MO-02 | P1 | Un rol por módulos sigue pudiendo usar APIs de staff fuera de `/admin` (venta en taquilla, invitaciones, portal de sponsors, escáner) | M | VERIFICADO |
| MO-03 | P1 | El rol «Contenido y mensajes» (núcleo) puede reescribir SMTP y email de administración | S | VERIFICADO |
| MO-04 | P1 | El dashboard de `/admin` ignora los módulos del usuario: ceros falsos o error en roles restringidos | S | VERIFICADO |
| MO-05 | P1 | El escáner (`/acceso`, `GET /api/events`) no está en la allowlist: la puerta se corta en BLOCKED o con Entradas apagado, contra lo que promete el doc | S | VERIFICADO |
| MO-06 | P1 | Contabilidad sin Entradas: enlace a `/admin/eventos` que da 404 de texto plano; los 404 por módulo no tienen chrome | S | VERIFICADO |
| MO-07 | P1 | Terminología «Caseta/Feria» en el admin y Contabilidad con categorías de bar fijas | S/M | VERIFICADO |
| MO-08 | P1 | Wallets se vende con Tienda pero solo funciona con Entradas | S | VERIFICADO |
| MO-09 | P1 | Ajustes sin efecto: pestaña «Redes sociales» y «Banner de cookies: Ocultar» | S | VERIFICADO |
| MO-10 | P1 | Estados de licencia: aviso GRACE casi ilegible en tema claro, sin contacto ni enlace; BLOCKED sin salida | S | VERIFICADO (código) / PROBABLE (contraste) |
| MO-11 | P1 | Apagar un módulo no tiene protocolo (sin guardas, sin ventana de cierre, sin política de datos) | M/L | VERIFICADO |
| MO-12 | P1 | No hay kill-switch por módulo ni flags de rollout: solo «revocar cliente», «quitar módulo» y un flag por evento | M | VERIFICADO |
| MO-13…MO-19 | P2 | Ver sección 3 | — | — |

---

## 1. Mecanismo REAL de activación por cliente (sección 3 del encargo, parte descriptiva)

**Origen.** El panel (`apps/control-panel`) guarda `SubscriptionModule(subscriptionId, moduleKey, source MANUAL|KEY, enabledAt, enabledBy)` y `ModuleDef(productKey, key, isCore, monthlyAddon)` (`apps/control-panel/prisma/schema.prisma:100-176`). `setModules` borra/crea filas y audita (`lib/services/tenants.ts:142-166`). La acción responde «Módulos guardados. Publica para que lleguen a la web del cliente.» (`app/actions/tenants.ts:196-197`): **cambiar módulos no llega al cliente hasta «Publicar»** (pastilla «Cambios sin publicar», `app/_components/ui.tsx:23-24`) o hasta el refresco diario `snapshots-refresh` a las 04:17 UTC (`apps/control-panel/vercel.json`).

**Transporte.** El snapshot de enrutado (firmado Ed25519, `RoutingRecord`) lleva `modules: string[]` (texto libre a propósito, máx. 64) y `license {phase, nextPhaseChangeAt, schedule}` (`packages/contracts/src/routing-record.ts`). Se guarda en Upstash; el front lo lee con token de solo lectura (`lib/tenant/resolve.ts:44-62`).

**Resolución en el front.** `platformMiddleware` resuelve el Host (`resolveHost`), calcula la fase efectiva, aplica `gateByModuleAndLicense` y firma el contexto en una cabecera interna (HMAC) que viaja a los handlers (`lib/tenant/middleware.ts:112-210`). Los handlers/páginas leen `getActiveModules()` → `enabledModules(ctx.modules)` (`lib/modules/runtime.ts:10-18`). El layout raíz pasa `modules` al cliente vía `BrandProvider` (`app/layout.tsx:100`), el layout público a `PublicNav` (`app/(public)/layout.tsx:22`) y el de admin a `AdminShell` (`app/admin/layout.tsx:9`). Un módulo desconocido se ignora (deny, `contracts/src/modules.ts:13-19`).

**Caché y retraso de propagación (peor caso razonable tras pulsar «Publicar»):**
- L1 en memoria por instancia: 15 s con jitter (`L1_TTL_MS`, `resolve.ts:81`); negativa 30 s; single-flight.
- CDN: las páginas públicas llevan `Vercel-CDN-Cache-Control: max-age=60, stale-while-revalidate=30` (`next.config.js:138-142`) y la etiqueta `t:{tenantId}:public`. El middleware se evalúa antes y corta rutas de un módulo retirado en ≤15 s; pero el HTML de la home cacheado (con enlaces al módulo) puede vivir hasta ~90 s.
- Cliente ya cargado: `modules` viaja en el HTML; hasta recargar, el menú del admin y la nav pública del navegador abierto no cambian.
- Total típico: 15-105 s tras publicar. Sin publicar: hasta el siguiente 04:17 UTC.

**Panel/registro caído.** Se sirve el último valor BUENO hasta `MAX_STALE_SERVE_MS` = 6 h por instancia (`resolve.ts:83`); si la instancia es nueva y el registro no responde → 503 (`unavailable`). Un snapshot sano caduca a los 30 días (`DEFAULT_SNAPSHOT_MAX_AGE_MS`) y su `staleUntil` (168 h) impide que la fase de licencia **empeore** con lectura obsoleta (`contracts/src/license.ts`, `effectiveLicensePhase`). Consecuencia: con el panel caído **no se pueden apagar módulos ni cobrar** (ni se corta a nadie por impago) — decisión consciente a favor del cliente. La revocación de emergencia (`revoked:{tenantId}`, TTL 5 s, `resolve.ts:88`) sí actúa sin panel.

**Feature flags: NO existe ninguno.** Búsqueda en todo el repo (código, `package.json`, docs, `apps/`, `packages/`) de `harness`, `launchdarkly`, `unleash`, `flagsmith`, `growthbook`, `posthog`, `statsig`, `featureFlag`, `feature_flag`, `@vercel/flags`, `edge-config`, `openfeature`, `split.io`: **0 coincidencias**. Lo más parecido hoy:
- Módulos (derechos comerciales) en el snapshot.
- Banderas de datos por cliente: `AppConfig` (`contact_form_enabled`, `apple_wallet_enabled`, `smtp_enabled`, `phomemo_printer_enabled`…) y por evento (`Event.onlineSalesClosed`, `waitingRoomEnabled`, `ageWarningEnabled`).
- Variables de entorno globales (p. ej. `IMAGES_UNOPTIMIZED`, `next.config.js:44`).
- Revocación de emergencia por cliente (todo o nada).

---

## 2. Matriz módulo × superficie (resumida, contrastada con código)

Leyenda: OK = coherente · ⚠ = ver hallazgo · — = no aplica.

| Superficie | Núcleo solo | +Tienda | +Entradas | +Contabilidad | +Sponsors | +Wallets | Todos |
|---|---|---|---|---|---|---|---|
| Menú admin (`admin-shell.tsx:34-84,129-135`) | Dashboard, Mensajes, Usuarios, Apariencia, Secciones, Config. OK | + grupo Tienda OK | + Eventos/Operaciones/Modo noche/Escáner OK | + grupo **«Caseta»** ⚠ MO-07 | + Sponsors OK | sin entrada de menú (solo config) | OK, ⚠ roles (MO-02/04) |
| Rutas admin (registro) | 404 texto plano al resto ⚠ MO-06 | idem | idem | enlace a `/admin/eventos` ⚠ MO-06 | OK | — | OK |
| Dashboard `/admin` (`app/admin/page.tsx:19-32`) | `CoreDashboard` OK | `ShopDashboard` OK | `AdminDashboard`; sondea `/compras/temporadas` (404 silencioso) ⚠ MO-15 | `CoreDashboard` sin enlaces a Contabilidad (P2) | `CoreDashboard` sin enlaces a Sponsors (P2) | — | Entradas + Tienda embebida; ⚠ MO-04 por rol |
| Tabs Configuración (`configuracion/page.tsx:99-109`) | Contenido, **Redes (muerta)**, Conexiones, Legal, General ⚠ MO-09 | + Tienda | + Entradas | solo clave IA en Conexiones | + Sponsors | + Wallets (⚠ MO-08 con Tienda sin Entradas) | OK |
| Widgets/selectores cruzados | — | `TemporadaSelector` oculto por sondeo 404 (`pedidos/page.tsx:32`) | idem eventos | — | idem sponsors | — | OK |
| Nav pública (`public-nav.tsx:18-22,38-42`) | solo anclas + Contacto OK | + Tienda | + Eventos | — | + Patrocinio | — | OK |
| Pie (`public-footer.tsx:34-38`) | legal + Contacto OK | idem | idem | — | idem | — | OK |
| Sitemap (`app/sitemap.ts:19-60`) | home+legal OK | + `/tienda` (+fichas solo Drop) | + `/eventos` y slugs | — | + `/sponsors` | — | OK |
| Rutas API | default-deny OK (`registry.ts:15-99`) | OK | OK | OK | OK | `/api/wallet` exige además Entradas en el handler | OK |
| Textos | ⚠ MO-13 (legal, ayuda de Config, preview de Apariencia) | ⚠ MO-01 (confirmación) | ⚠ MO-01 (`/eventos`) | ⚠ MO-07 | ⚠ MO-01 (`/sponsors` en Feria) | — | — |

**Qué ve cada rol con módulos apagados**

| Rol | Menú | Dashboard | Config | Rutas fuera de `/admin` |
|---|---|---|---|---|
| ADMIN propietario (`mods` ausente) | solo módulos activos; «Escáner QR» si hay Entradas | por módulos del cliente | pestañas de módulos activos | todo |
| ADMIN con rol por módulos | además filtra por `userModules` (`admin-shell.tsx:132`) pero **«Escáner QR» no** (`:135`) | **ignora el rol** (MO-04) | filtra por rol (OK) | **no se restringe** (MO-02) |
| TAQUILLA | no entra a `/admin` (redirige a login, `tenant/middleware.ts:169`) | — | — | `/acceso` + APIs de taquilla/escáner; con Entradas apagado `/acceso` da 404 de texto plano (MO-05) |
| Rol personalizado con alias | igual que ADMIN restringido; los roles no dependen de qué módulos tiene el cliente (MO-16) | idem | idem | idem |

---

## 3. Hallazgos

### MO-01 · P0 · Textos y estética de La Grailla visibles al público de otros clientes
**Problema.** Tres puntos de la web pública (no del admin) pintan vocabulario de caseta/noche fijo para cualquier cliente.
**Evidencia.**
- `app/(public)/tienda/confirmacion/[orderId]/_components/shop-confirmation-client.tsx:204`: `<p …>¡Nos vemos en la caseta! 🍻</p>`, sin condición, en el recibo de TODA compra de tienda.
- `app/(public)/eventos/page.tsx:82-97`: la cabecera por defecto (`hero-gradient`, `brand-sticker text-lima`, «PROGRAMACIÓN», «Noches que no se pierden») se usa para toda plantilla que no tenga rama propia. No hay rama `editorial` ni `hasBanner` en este fichero (el `grep` solo devuelve `editorial` en `page.tsx:151`), y `editorial` es la plantilla de partida de un cliente nuevo (`lib/brand/brand.ts:73-79`).
- `app/(public)/sponsors/page.tsx:44-66`: con Feria (no `hasBanner`), «Tu marca en la caseta», «PARA MARCAS», «alrededor de cada noche»; Feria es seleccionable por cualquier cliente y es el `default` del esquema del tema (`lib/brand/theme.ts:156`). Además `app/(public)/page.tsx:202` («Estamos montando la próxima fiesta») y `eventos/page.tsx:129` («Estamos cerrando la próxima noche»).
**Escenario.** Cliente nuevo (p. ej. un club de pádel) con Entradas y plantilla neutra por defecto: su `/eventos`, la página que más enlaza la nav, enseña «Noches que no se pierden» con el sticker lima de La Grailla. Un comprador de su tienda lee «¡Nos vemos en la caseta! 🍻».
**Impacto.** Rompe la promesa white-label justo en las páginas que ve el cliente final; el cliente lo detecta en la primera demo. Los docs (`revision-modulos…md:261`) dan por resuelto el problema para páginas interiores, pero `/eventos` en Editorial queda fuera.
**Solución.** (1) Quitar la línea de la confirmación o llevarla a `home_shop_thanks` (config con valor vacío por defecto). (2) Añadir `editorial` a `BANNER_TEMPLATES`-aware en `/eventos` (usar `PageBanner` con textos de config: `home_events_title`/`subtitle`, valores neutros «Eventos»/«Próximas fechas»). (3) Sacar los textos fijos de Feria a `getConfigs` con el valor legacy solo en `isLegacyTenant()` (patrón ya usado en `lib/config.ts:84`). (4) Test: render de las páginas públicas con tenant no-legacy + plantilla `editorial`/`feria` y `expect(html).not.toMatch(/caseta|Noches que|Grailla/i)`.
**Esfuerzo.** S. **Confianza.** VERIFICADO en código.

### MO-02 · P1 · Un rol por módulos sigue operando APIs de staff fuera de `/admin`
**Problema.** La restricción por módulos solo se aplica a `/admin` y `/api/admin`: `pathAllowedForModules` devuelve `true` para cualquier otra ruta (`lib/modules/access.ts:46-50`). Los handlers de fuera solo exigen `ADMIN` o `TAQUILLA`, sin mirar `session.user.modules`.
**Evidencia.**
- `app/api/taquilla/sale/route.ts:40-41`, `app/api/invitations/route.ts:29-30`, `app/api/guest-lists/route.ts:19-20`: `['ADMIN','TAQUILLA'].includes(role)`.
- `lib/access-token.ts:98-101` (`isAdminSession` = `role === 'ADMIN'`) y `:160-163` (`allowSponsorAccess`): cualquier ADMIN accede al portal/gestión de un sponsor.
- `admin-shell.tsx:135`: el enlace «Escáner QR» se muestra con independencia del rol.
- Ningún test cubre rutas de staff fuera de `/admin` con rol restringido (`tests/lib/access-modules.test.ts` solo prueba `/admin` y `/api/admin`; `grep` en `tests/` no encuentra `taquilla|invitations|scan` en los tests de roles).
**Escenario.** El cliente crea «Gestor de tienda» (`modules:['tienda']`). Ese usuario abre `/acceso`, vende entradas en taquilla, emite invitaciones (entradas gratis), lee/edita datos y subidas de cualquier sponsor y lista borradores de eventos (`/api/events`, `isAdminSession`). Igual un «Contable» o «Contenido y mensajes».
**Impacto.** El argumento comercial «cada empleado solo ve su módulo» es falso para Entradas y Sponsors. Es riesgo interno (no de otro tenant), pero con dinero (invitaciones/ventas en efectivo) y datos de terceros (sponsors). Convertir a P0 si los roles se enseñan en la demo como control de acceso.
**Solución.** Una sola función `requireStaffForModule(session, 'entradas'|'sponsors', {allowTaquilla})` en `lib/modules/access.ts` que use `userModules` (null = propietario) y se llame en los ~10 handlers de staff fuera de `/admin`. En middleware: extender `pathAllowedForModules` a `/api/taquilla`, `/api/invitations`, `/api/guest-lists`, `/api/scan`, `/api/access`, `/acceso` (dueño `entradas`, ya en el registro) para roles restringidos (TAQUILLA queda sin `mods`, no cambia). Ocultar «Escáner QR» con `pathAllowedForModules('/acceso', userModules)`. Test genérico: para cada ruta con `isStaffApiPath` o dueño ≠ núcleo, un ADMIN `mods=['tienda']` recibe 403.
**Esfuerzo.** M. **Confianza.** VERIFICADO.

### MO-03 · P1 · «Contenido y mensajes» (núcleo) puede reescribir SMTP y el email de administración
**Problema.** SMTP y `admin_email` son del núcleo (`lib/config-ownership.ts`: `'admin_email','smtp_enabled','smtp_host','smtp_port','smtp_user','smtp_password',…`), y el preset `contenido` tiene `modules:['nucleo']` (`access.ts:19`). La API de config filtra por `userModules` (`app/api/admin/config/route.ts:41,70`), así que quien tenga `nucleo` ve y guarda SMTP; la pestaña «Conexiones» se muestra con `core` (`configuracion/page.tsx:32,299`).
**Escenario.** Un redactor con rol «Contenido y mensajes» pone su propio servidor SMTP: todos los correos de entradas, confirmaciones y avisos (con datos de compradores) salen por él; o cambia `admin_email` y desvía los avisos.
**Impacto.** Exfiltración de PII de compradores desde un rol que se vende como inofensivo. (Las credenciales son de solo escritura: no las lee, pero sí las sustituye.) El propio doc lo propone como pendiente: «Permiso aparte para Conexiones: solo el propietario» (`revision…md:168`).
**Solución.** Separar `nucleo` en `nucleo` (contenido) y una pseudo-clave de propietario para «Conexiones» (`smtp_*`, `admin_email`, `abacus_ai_api_key`, pasarelas): en `isConfigKeyAllowed`, claves marcadas `ownerOnly` exigen `userModules === null`. Mismo criterio para `payment_gateway`/`stripe_*` de Entradas y `shop_*` (un gestor de entradas hoy puede cambiar la cuenta de cobro: límite «de confianza total en el módulo» documentado, pero conviene que sea decisión explícita).
**Esfuerzo.** S. **Confianza.** VERIFICADO.

### MO-04 · P1 · El dashboard ignora los módulos del usuario
**Problema.** `app/admin/page.tsx:19-32` decide por módulos del cliente, no del usuario. `AdminDashboard` pide `/api/admin/stats` y hace `setStats(data)` sin mirar `r.ok` (`admin-dashboard.tsx:59-61`); con 403 recibe `{error}` y pinta `0.00€`, `0`, `0`, `0` (`:108-111`). `ShopDashboard` sí detecta el fallo y muestra «No se han podido cargar los datos de la tienda.» (`shop-dashboard.tsx:104`), engañoso para quien no tiene permiso.
**Escenario.** Cliente con Entradas+Tienda; «Contable» o «Gestor de sponsors» entra y ve «Ingresos 0,00 €, Entradas vendidas 0» y, debajo, un aviso de error de la tienda. Además «Ver estadísticas» lleva a `/admin/estadisticas` → redirección silenciosa a `/admin` (`tenant/middleware.ts:179-181`).
**Impacto.** Tickets de soporte («mis ventas están a cero»), pérdida de confianza.
**Solución.** `page.tsx` pasa `userModules` (de `getServerSession`) y compone por intersección `getActiveModules() ∩ userModules`; si queda vacío, un `CoreDashboard` con enlaces a SUS módulos. Mejor: registro de widgets por módulo `{owner, component}` (punto 4 de `revision…md:184`) y un `CoreDashboard` que lista accesos a los módulos del usuario (hoy Contabilidad y Sponsors no tienen acceso desde el inicio). Comprobar `r.ok` en `AdminDashboard`.
**Esfuerzo.** S. **Confianza.** VERIFICADO.

### MO-05 · P1 (rozando P0 si coincide con un evento) · El escáner no está en la allowlist «nunca bloqueable»
**Problema.** `isLicenseExempt` exime `/api/scan` y `/api/access` (`registry.ts:148`), con la intención explícita «en la puerta de un evento hay que seguir validando entradas ya vendidas» (`registry.ts:139-142`; `m5-modulos-licencia.md`). Pero la **página** `/acceso` y `GET /api/events?status=PUBLISHED` (que usa el escáner para elegir evento, `app/acceso/_components/access-client.tsx:60`) tienen dueño `entradas` y no están exentos.
**Evidencia.** `gating.test.ts:127-150` prueba la exención con `/api/scan` y `/api/access/capacity`, no con `/acceso` ni `/api/events`. `gateByModuleAndLicense` aplica el 404/503 a todo lo no exento (`tenant/middleware.ts:70-81`).
**Escenario.** (a) Cliente en BLOCKED (22 días sin pagar) con evento esa noche: el taquillero inicia sesión (`/auth/login` es exento) → el login redirige a `/acceso` → 503 «Este sitio no está disponible» sin botón ni contacto. Un móvil con la PWA ya cargada sigue escaneando; uno que recargue, no. (b) Cliente al que se quita Entradas con entradas vendidas y evento próximo: `/acceso` y la lista de eventos dan 404 de texto plano, pero `/api/scan` sigue vivo.
**Impacto.** Compradores que ya pagaron rechazados en la puerta: daño reputacional y reclamaciones frente al organizador, y contradicción entre doc y comportamiento. (Si la política real es cortar todo en BLOCKED, hay que decirlo y quitar la excepción de la API para no tener una mitad.)
**Solución.** Decidir política y alinearla: o bien eximir `/acceso` (GET) y `GET /api/events` de solo lectura para sesión de staff, o bien documentar que BLOCKED corta también la puerta. Añadir `/acceso` y `/api/events` a `gating.test.ts` BLOCKED. Con módulo Entradas apagado y eventos futuros con entradas vendidas, ver MO-11.
**Esfuerzo.** S. **Confianza.** VERIFICADO.

### MO-06 · P1 · Enlaces a rutas inexistentes y 404 sin chrome
**Problema A.** `EventosEnlazados` se renderiza siempre en Compras y Gastos (`app/admin/compras/page.tsx:60`, `app/admin/gastos/page.tsx:131`). Sin Entradas, `GET /api/admin/events` da 404, la lista queda vacía y el popover dice «Ningún evento enlazado todavía. Enlázalos desde **Eventos**» con `<Link href="/admin/eventos">` (`eventos-enlazados.tsx:15-20,41-46`).
**Problema B.** Ese enlace (y cualquier marcador/URL antigua) aterriza en `plain(404,'No encontrado')` (`tenant/middleware.ts:147`): texto plano sin menú ni forma de volver. Igual en la web pública para `/eventos`, `/tienda`… de un módulo retirado (aunque `app/not-found.tsx` existe, no lo usa el middleware).
**Escenario.** Cliente «núcleo + contabilidad»: abre Gastos, pulsa «0 eventos enlazados» → «Eventos» → pantalla blanca «No encontrado». Con rol «Contable» y Entradas activas: el sondeo da 403, lista vacía y el enlace redirige en silencio a `/admin`.
**Solución.** Pasar `modules` (y `userModules`) por props a las páginas de admin: `EventosEnlazados` solo si `entradas` está activo y permitido. Para 404 de módulo, hacer `NextResponse.rewrite` a una ruta `/no-disponible` (HTML con la marca y enlace a inicio/admin, status 404) en lugar de texto plano; en admin, con el shell. Mantener JSON para API.
**Esfuerzo.** S. **Confianza.** VERIFICADO.

### MO-07 · P1 · Terminología heredada («Caseta») y Contabilidad con vertical fijo
**Clasificación.** El admin de **todos** los clientes con Contabilidad ve estas etiquetas (fuga a otros clientes), salvo lo que es semilla del tenant legacy.
**Evidencia.**
- `admin-shell.tsx:66` grupo de menú **«Caseta»**.
- Descripciones de página: «pedidos de la caseta» (`app/admin/compras/page.tsx:48`), «Caja física de la caseta» (`ingresos/page.tsx:100`), «Contabilidad real de la caseta» (`gastos/page.tsx:119`); ayudas «Vincula este evento/producto a la temporada de Compras/Gastos de la caseta» (`events-manager.tsx:281`, `productos/page.tsx:463`).
- Nombre por defecto al crear temporada: `Feria de Septiembre ${año}` (`temporada-selector.tsx:88`).
- Categorías fijas orientadas a bar: `CATEGORIAS_ARTICULO` (Refrescos, Cervezas, Espirituosos…), `CATEGORIAS_GASTO` («Bebidas y bar», «Alquiler de puesto», «Hielo y perecederos»), `CONCEPTOS_INGRESO` («Barra») en `lib/compras/constantes.ts:1-31`; categoría de bar prefijada en `gasto-desde-pedido-dialog.tsx:58`.
- Prompts de IA: «proveedores de bebidas para una caseta de feria» y «festivales, ferias, discotecas» (`lib/abacus-ai-adapter.ts:36,108`).
- Copy «Ambiente de feria o fiesta» en `lib/sponsor-guided-questions.ts:74`.
**Legítimo (semilla legacy, sin acción):** `LA_GRAILLA_SEED` y valores por defecto de `lib/config.ts` (ya cerrados con `isLegacyTenant`, `config.ts:84`), `app/admin/apariencia` (`feria` es una plantilla), claves de `localStorage` `lagrailla_cart`, `lagrailla_cookie_consent`, `la-grailla-active-event` (solo nombres, por origen; P2), correos placeholder `taquilla@lagrailla.local`/`invitacion@lagrailla.local` (`taquilla/sale/route.ts:122`, `invitations/route.ts:93`: se guardan en `buyerEmail`; aparecen en exportaciones y deben filtrarse al enviar correos).
**Escenario.** Una academia con Contabilidad ve «Caseta», «Feria de Septiembre 2026», «Hielo y perecederos». Es el módulo más vertical del producto (modelo Temporada/Artículo/Planificador de consumo).
**Solución.** (1) Renombrar a «Compras y gastos» / «Contabilidad». (2) Categorías y conceptos en `AppConfig` con la lista actual solo como semilla del legacy. (3) Prompts con vertical configurable o texto neutro. (4) Decidir producto: si Contabilidad es «para hostelería/eventos», decirlo en el catálogo comercial.
**Esfuerzo.** S (etiquetas) / M (categorías por cliente). **Confianza.** VERIFICADO.

### MO-08 · P1 · Wallets se puede vender con Tienda pero solo funciona con Entradas
**Evidencia.** `MODULE_REQUIRES_ANY = { wallets: ['entradas','tienda'] }` (`registry.ts:128`) activa pestaña de config y ruta; pero los handlers exigen Entradas (`app/api/wallet/apple/[ticketId]/route.ts:14`, idem Google) y `getWalletAvailability` solo sirve pases de tickets (`lib/tickets.ts:215`). El propio doc lo reconoce (`revision…md:117`).
**Escenario.** «Núcleo + tienda + wallets» (suplemento mensual): aparece la pestaña «Wallets» con certificados Apple/Google, pero ningún comprador puede obtener un pase. Cobro por un producto sin función.
**Solución.** Cambiar a `wallets: ['entradas']` hasta que exista la tarjeta de fidelización; el panel debe impedir marcar Wallets sin Entradas (validación en `resolveModules`).
**Esfuerzo.** S. **Confianza.** VERIFICADO.

### MO-09 · P1 · Ajustes que se guardan pero no hacen nada
**Evidencia.** `grep` de `social_*`, `cookies_banner_enabled` y `maps_provider` en `app/`, `components/`, `lib/` solo encuentra su declaración (`lib/config.ts:21-43`, `config-ownership.ts`) y el formulario (`configuracion/page.tsx:106,288-295,366-380`). `CookieBanner` se monta siempre (`app/(public)/layout.tsx:26`) y el pie no pinta redes (`public-footer.tsx`).
**Escenario.** El cliente rellena Instagram y espera iconos en el pie; pone «Banner de cookies: Ocultar» y el banner sigue. Es de las primeras cosas que probará un cliente en validación.
**Impacto.** Soporte + riesgo legal por expectativa errónea con cookies (el banner no se puede apagar aunque la UI diga que sí).
**Solución.** Pintar redes en el pie (S) y hacer que `cookies_banner_enabled=false` oculte el banner solo si no se usan cookies no esenciales (o retirar el selector). Si no se hace ya: ocultar la pestaña «Redes sociales» y el selector hasta que funcionen.
**Esfuerzo.** S. **Confianza.** VERIFICADO.

### MO-10 · P1 · Estados de licencia: contraste, contacto y callejones sin salida
**Evidencia y escenarios.**
- **GRACE.** Banner en el admin con `text-amber-200` sobre `bg-amber-500/10` fijo (`admin-shell.tsx:221`), sin variante `dark:`. El tema por defecto de un cliente nuevo es claro (`brand.ts:73-79`, `mode:'light'`; `app/layout.tsx:99` aplica `brand.mode` también al admin): amarillo muy claro sobre fondo blanco, **ilegible** (PROBABLE por cálculo, sin render). Es el aviso que protege el cobro. Además no dice a quién pagar ni cómo (sin email/enlace) y se muestra también a roles que no pueden pagar. TAQUILLA nunca lo ve.
- **PANEL_BLOCKED.** El admin llega a `/licencia` (402): título «El panel está bloqueado», un único botón «Ir a la web» (`app/licencia/page.tsx:30-45`); sin contacto del proveedor, sin cerrar sesión, sin decir que el escáner y las ventas siguen para el personal de puerta.
- **BLOCKED.** Texto «contacta con tu proveedor» pero sin quién; **ningún botón** (`panelOnly` falso, `:40`): TAQUILLA que inicia sesión → `/acceso` → misma pantalla sin salida. El visitante final ve «Este sitio no está disponible» sin marca del cliente.
- `/licencia` reutiliza `hero-gradient`/`brand-sticker text-lima` (estética Feria) en todos los clientes.
**Solución.** Fase ↔ mensaje definido por el panel: `RoutingRecord` aditivo `support: {email?, url?}` (por producto, no por cliente) para mostrar «Escribe a {x}»; banner con tokens de tema (`bg-warning/10 text-warning-foreground`) y solo al propietario; botón «Cerrar sesión» en `/licencia`; resolver MO-05 para la puerta; en BLOCKED mostrar nombre/logo del cliente.
**Esfuerzo.** S. **Confianza.** VERIFICADO (código), PROBABLE (contraste).

### MO-11 · P1 · Apagar un módulo no tiene protocolo ni política de datos
**Problema.** `setModules` elimina filas y audita, nada más (`lib/services/tenants.ts:142-166`); la ficha solo tiene casillas (`app/tenants/[id]/page.tsx:347-350`). No comprueba pedidos PENDING, eventos futuros con entradas vendidas, pedidos de tienda sin enviar, sponsors con vídeo pendiente de pago, ni avisa del 404 inmediato de URLs indexadas. No hay estado intermedio.
**Qué queda en BD y quién lo lee** (verificado): todas las tablas del módulo permanecen (`revision…md:190`). Lo siguen leyendo, con el módulo apagado: el cron `reconcile-payments` (mezcla `Order` y `ShopOrder` por diseño, `app/api/cron/reconcile-payments/route.ts:68-110`) y los webhooks (exentos); los GET de comprador con token (`/api/orders/{id}`, `/api/shop/orders/{id}`, `/api/tickets/*`, `/confirmacion/*`); `/api/scan` y `/api/access` (staff); `PATCH /api/admin/orders/{id}` para reembolsar/cancelar. Nadie más desde la web (test `module-off-zero-data` lo comprueba para GET de handlers; **no cubre páginas ni escrituras**, `revision…md:33`). Un operador con acceso a la BD (Neon) lo ve todo. No hay purga ni exportación previa: datos personales de compradores se conservan indefinidamente sin política (RGPD: plazo, derecho de supresión; `revision…md:98` lista «RGPD por interesado» como pendiente).
**Escenario.** Operador desmarca «Entradas» a un cliente con un evento el sábado y 300 entradas vendidas: viernes, `/eventos` y la compra dan 404 (bien), el escáner también (MO-05), el admin pierde `/admin/noche`; no hay aviso.
**Solución.** Ver contrato en la sección 4.3: estado `WINDING_DOWN` (ventas cerradas, obligaciones abiertas hasta que no queden bloqueos) y guardas en el panel con anulación auditada; exportación previa; retención y purga configurables.
**Esfuerzo.** M (guardas + estado) / L (retención y purga). **Confianza.** VERIFICADO.

### MO-12 · P1 · Faltan kill-switch por módulo y flags de rollout
**Problema.** Ante un fallo en producción de un solo flujo (p. ej. checkout de tienda) las palancas son: «Revocar acceso ahora» (todo el cliente, `m5` doc), quitar el módulo (404 duro + publicar) o editar un evento (`Event.onlineSalesClosed`, que solo cierra Entradas online por evento, `app/api/orders/route.ts:105`). No hay «pausar ventas online» a nivel cliente ni por módulo, ni despliegue progresivo por cliente (el despliegue es único y compartido: `PLATFORM_MODE` en un solo proyecto), así que cualquier cambio llega a todos los clientes a la vez. Diseño en la sección 4.
**Esfuerzo.** M. **Confianza.** VERIFICADO.

### MO-13 · P2 · Residuos de módulos inexistentes en textos genéricos
- Texto legal por defecto: «entradas, pedidos y comunicaciones relacionadas con el evento» (`app/(public)/legal/privacidad/page.tsx:25`) también para un cliente solo núcleo; genérico y sin identificar al responsable del tratamiento.
- Ayuda de Config > Contenido: «Los textos de cada sección de negocio (eventos, tienda, sponsors) están en la pestaña de su módulo» (`configuracion/page.tsx:248`).
- Vista previa de Apariencia con «Eventos / Tienda», «Sáb 14 nov / Tu sala / Entradas», «Comprar entradas» (`app/admin/apariencia/page.tsx:101,114,129,193`) sin mirar módulos.
- `app/not-found.tsx`: «Esta puerta no existe», `brand-sticker` lima, `hero-gradient`.
**Solución.** Frases condicionales por `modules`; vista previa que oculta enlaces de módulos ausentes; 404 neutra. **Esfuerzo.** S.

### MO-14 · P2 · Navegación y registro en seis listas manuales, sin test de navegación
Fuentes paralelas que hay que mantener a mano: `registry.ts` (rutas), `admin-shell.tsx:34-84` (menú), `public-nav.tsx:18-22` y `public-footer.tsx:34-38` (enlaces públicos), `access.ts:14-20` (roles), `config-ownership.ts` (claves), `MODEL_OWNERS` del test (tablas), `sitemap.ts`. No existe test que recorra el menú × combinaciones de módulos (el `grep` de `admin-shell|isLinkVisible|PublicNav` en `tests/` es vacío): hoy los enlaces correctos dependen de `isLinkVisible`, y nada impide añadir un `NavItem` cuyo href no exista. **Solución.** Manifiesto por módulo (sección 4.2) y un test `nav-matrix`: para cada subconjunto de módulos ≥ núcleo, todos los href visibles tienen página (`app/**/page.tsx`) y `ownerEnabled`; ningún href oculto es alcanzable desde un componente de la misma pantalla. **Esfuerzo.** M.

### MO-15 · P2 · Dashboards y formularios «sondean» módulos por 404
`AdminDashboard` (`admin-dashboard.tsx:66`), `pedidos/page.tsx:32`, `productos/page.tsx:81`, `sponsors/page.tsx:81`, `sponsors/[id]/page.tsx:129`, `eventos/_components/events-manager.tsx:87` y `EventosEnlazados` llaman a `/api/admin/compras/temporadas` y deducen el módulo de `r.ok`. Funciona (el middleware responde 404 y la UI lo oculta), pero genera una petición muerta por carga (invocación de edge + ruido en logs/monitorización) y confunde 403/404/500. **Solución.** `useBrand().modules` ya está en el cliente: condicionar el `fetch` con `modules.includes('contabilidad')` y el rol; o prop desde el servidor. **Esfuerzo.** S.

### MO-16 · P2 · Roles ofrecidos que no existen para ese cliente
`app/admin/usuarios/page.tsx:178` lista los 5 roles predefinidos sin filtrar por módulos del cliente; `validateCustomRole` acepta cualquier módulo conocido (`access.ts:60-69`). Un cliente solo-núcleo puede crear «Gestor de entradas». Efecto inofensivo (sin acceso a lo inexistente) pero confuso; roles huérfanos tras apagar un módulo. **Solución.** Filtrar por `ctx.modules` y marcar «inactivo» los roles cuyos módulos se apagaron (se conservan para reactivar). **Esfuerzo.** S.

### MO-17 · P2 · Defensa en profundidad: endpoints con dinero sin comprobación de módulo en el handler
Los usos de `isModuleEnabled`/`isFullAccessRestricted`/`getActiveModules` en handlers se limitan a `app/api/wallet/*`, `users`, `admin/orders/[id]`, `gastos/resumen`, `ventas-por-dia`, `config` y `season-link`. `POST /api/orders`, `POST /api/shop/orders`, `POST /api/taquilla/sale`, `/api/webhooks/*` y los crons confían solo en el middleware (`grep` sin coincidencias). Riesgo bajo hoy (default-deny probado, matcher cubre `/api`), pero un cambio en el matcher o en `normalize()` abriría todos a la vez. **Solución.** `requireModule(owner)` de una línea (404 JSON) en las 3 rutas de cobro y en `taquilla/sale`; los webhooks y el cron quedan fuera a propósito (dinero en vuelo). **Esfuerzo.** S.

### MO-18 · P2 · Callejones menores de sesión y redirección
- Un ADMIN restringido que abre una ruta no permitida es redirigido a `/admin` sin mensaje (`tenant/middleware.ts:179-181`).
- TAQUILLA que abre `/admin` va al formulario de login aunque tenga sesión (`:169`); el login no redirige a quien ya está dentro.
- Tras iniciar sesión se va siempre a `/admin` o `/acceso`, nunca a la URL solicitada (`login-form.tsx:28-36`; sin `callbackUrl`).
- Cliente cuyos usuarios TAQUILLA quedan huérfanos al quitar Entradas: `users/route.ts:55` impide crearlos, no neutraliza los existentes.
**Solución.** Mensaje «No tienes acceso a esa sección», `callbackUrl` validado, comprobar sesión en `/auth/login`. **Esfuerzo.** S.

### MO-19 · P2 · Otros
- `CoreDashboard` no enlaza a Contabilidad ni a Sponsors (`core-dashboard.tsx:25-30`).
- Plantillas de Apariencia no avisan de qué módulos necesitan (p. ej. «Drop» sin Tienda, «Marquesina» sin Entradas).
- La carpeta vacía `app/api/patrocinadores/[sponsorId]/{creatividad,logo}` no tiene handlers (solo directorios): residuo sin efecto; borrar.
- `PLATFORM_MODE` desactivado por error → `getActiveModules()` devuelve todos (`runtime.ts:11`); el aislamiento de módulos dejaría de aplicar (mitigado por `env-check` y por que sin plataforma tampoco hay BD por cliente). Añadir al preflight un aviso explícito.

---

## 4. Desacople por módulo, flags de rollout y contrato de desactivación

### 4.1 Punto de partida (qué ya tiene la plataforma)
El derecho comercial (módulos) está en un registro **firmado, tolerante a caídas y fail-closed**, con propagación en segundos: es la base correcta para entitlements y no conviene moverla. Lo que falta no es una herramienta, sino (a) un único manifiesto por módulo, (b) una capa de **flags operativos** con alcance por cliente y (c) un canal de **kill-switch** de baja latencia.

### 4.2 Desacople limpio con targeting por cliente
1. **Manifiesto por módulo** `lib/modules/<m>/manifest.ts` (single source of truth): `{ key, routes[], navItems[], publicLinks[], dashboardWidgets[{id, requires}], configKeys[], models[], requires[], provides[], rolePresets[], onDisable }`. `registry.ts`, `admin-shell`, `public-nav/footer`, `sitemap`, `config-ownership`, `PRESET_ROLES` y `MODEL_OWNERS` se derivan de ahí. Elimina las 7 listas paralelas de MO-14 y hace imposible un enlace huérfano.
2. **Puertos entre módulos** (`lib/modules/ports.ts`): Contabilidad pide ingresos a `RevenueSource[]` registrados por Entradas/Sponsors/Tienda solo si están activos; hoy `gastos/resumen` lee `event/order/sponsor` directamente con `if (isModuleEnabled)` (`resumen/route.ts:35-36`) y `ventas-por-dia` lee `ingreso`. Regla ESLint (`no-restricted-syntax`) que prohíba `prisma.<modelo ajeno>` fuera del módulo dueño (el análisis estático de este informe, script `xmod.py`, solo halló 4 cruces directos en `app/`: `gastos/resumen`, `ventas-por-dia`, `wallet/apple` y `wallet/google`; los demás cruces son `temporadaId`).
3. **Cruce por esquema** `temporadaId` en `Event`, `Product`, `ShopOrder`, `SponsorRequest` (`schema.prisma:187-448`): a medio plazo, tabla de vínculo propiedad de Contabilidad (`SeasonLink(entityType, entityId, temporadaId)`) para que apagar Contabilidad deje de tocar tablas ajenas (L, aditivo con backfill).
4. **Targeting por cliente.** La unidad de targeting es `tenantId` (y etiquetas de cohorte: `legacy`, `interno`, `piloto`, `general`). No hay usuarios finales que segmentar: con 2-15 clientes un porcentaje es ruido; una **lista de clientes por flag** es lo que se necesita.

### 4.3 Flags de rollout sobre el mecanismo existente
Cuatro tipos, con distinto canal:

| Tipo | Quién lo cambia | Canal | Latencia | Ejemplo |
|---|---|---|---|---|
| **Entitlement** (comercial) | operador, con pago | snapshot firmado (ya existe: `modules`, `license`) | publicar + ≤15 s | `tienda`, `wallets` |
| **Rollout** (despliegue progresivo) | operador | campo aditivo `flags` en el snapshot firmado | publicar + ≤15 s | `entradas.checkout_v2` encendido primero en `legacy`→`piloto`→todos |
| **Kill-switch** | operador, emergencia | clave **no firmada y solo-resta** en el registro, leída con TTL 5 s (misma lógica que `revoked:{tenantId}`, `resolve.ts:228-262`) | ≤5-15 s, sin republicar, sin panel | `entradas.checkout`, `tienda.checkout`, `wallet.issue` |
| **Operativo del cliente** | propietario del cliente | `AppConfig`/`Event` en su BD | inmediato | `sales_paused_online` (nuevo, por cliente), `Event.onlineSalesClosed` (ya existe) |

Piezas concretas (todas aditivas, compatibles con fronts antiguos):
- **Contrato:** `RoutingRecord.flags?: Record<string, boolean|number|string>` opcional (como se añadió `schedule`, `routing-record.ts`); `TenantContext.flags`; helper edge-safe `flag('entradas.checkout_v2', default)` con **valor por defecto en código** (desconocido ⇒ default seguro, igual que módulo desconocido ⇒ deny). Claves en un catálogo tipado `lib/flags/catalog.ts` con `{key, kind, ownerModule, default, reviewBy}` y un test que falla si un flag pasa de su fecha de revisión (evita deuda de flags).
- **Panel:** tablas `FeatureFlag(key, kind, default, ownerModule, reviewBy)` y `FlagOverride(tenantId, key, value, note, setBy, expiresAt)`; UI en la ficha del cliente; `publishSubscription` compila los overrides + cohortes en `record.flags` (hereda firma, auditoría `appendAudit` y la pastilla «Cambios sin publicar»).
- **Kill-switch:** un único valor `ops:{tenantId}` JSON `{revoked?, kill?: string[]}` leído en el mismo `GET` que hoy hace `isRevoked` (evita una segunda lectura a Upstash por cliente/5 s/instancia) y un `kill:*` global para «parar el flujo en todos». Solo puede **restar**: no necesita firma (argumento ya documentado para la revocación). Se aplica en `gateByModuleAndLicense` (503 JSON «ventas pausadas» en `POST /api/orders` etc.) y con `requireFlag()` en el handler (defensa en profundidad, MO-17). Lo que cobra dinero en vuelo (webhooks, crons, reembolsos) **nunca** se mata (allowlist).
- **Pausar ventas:** generalizar `onlineSalesClosed` (hoy por evento, `schema.prisma:160-172`) con `sales_paused_online` por cliente (dueño `entradas`/`tienda`) y con el mismo copy configurable; el kill-switch del operador lo fuerza aunque el cliente lo haya reabierto.
- **Despliegue progresivo.** Como el front es un único despliegue compartido, el único modo de hacer canary es **por cliente**: código nuevo detrás de flag `default:false`, encendido en `legacy`/interno, luego piloto, luego todos; apagar = quitar override o kill.

### 4.4 ¿Harness FFM u otra herramienta externa?
**Hoy: no.** Razonamiento honesto con 2-15 clientes:
- Lo que aporta una herramienta (targeting por usuario final, porcentajes, experimentos, auditoría/aprobaciones, UI para no técnicos, streaming) apenas se usa: el sujeto es el cliente, no el visitante; los cambios los hace 1 operador y ya hay auditoría (`appendAudit`) y pastilla de pendientes.
- Riesgos reales: un SDK en el camino crítico del middleware (edge) añade latencia y una dependencia más con modo de fallo propio (el diseño actual es «fail-closed con caché obsoleta»); un tercero más en el DPA/subencargados; coste por desarrollador/MAU/entorno (precios no verificados aquí, sin acceso a red: confirmar en la web de Harness antes de decidir); doble fuente de verdad con las licencias (los **entitlements nunca** deberían salir del snapshot firmado: es anti-manipulación y tolerante a caídas).
- **Cuándo sí:** cuando se cumplan varias de: >30-50 clientes; operadores no técnicos que deben activar/desactivar con flujos de aprobación y registro exigido por clientes (SOC2/ISO); necesidad de targeting por usuario final o porcentajes/experimentos; varios productos que comparten flags; propagación global <5 s para decenas de flags. Entonces conviene una herramienta **solo para rollout/experimentos**, nunca para entitlements.
- **Cobertura barata hoy:** envolver todo acceso en `lib/flags` con la interfaz de **OpenFeature** y un proveedor propio «snapshot»: si algún día se adopta Harness (u otro), se cambia el proveedor sin tocar los puntos de uso (S).

### 4.5 Contrato: «desactivar un módulo sin degradar experiencia ni dejar datos/endpoints expuestos»
Un módulo se considera correctamente apagado si, y solo si, se cumple TODO esto (cada punto con su test):
1. **Alcance.** Toda ruta (página, API) del módulo da 404 (HTML con marca para páginas, JSON para API). ✔ hoy (default-deny + `tests/tenant/gating.test.ts`). Mejora: 404 con chrome (MO-06).
2. **Navegación.** Ningún menú, enlace, CTA, widget, sitemap, pie, email, PDF, sugerencia o selector referencia el módulo ni a una ruta suya; ningún texto lo menciona. Parcial hoy (menú/nav/pie/sitemap ✔; selectores por sondeo, dashboard por rol, enlaces cruzados y textos ✘: MO-04/06/13/15). Test `nav-matrix` (MO-14).
3. **Datos.** Ningún handler ni página fuera del módulo lee o escribe sus tablas; claves de config del módulo ocultas y rechazadas; sin FKs expuestas (`temporadaId`). ✔ para GET de handlers y config; ✘ páginas, escrituras (ampliar `module-off-zero-data` a server components y a POST/PUT/PATCH/DELETE).
4. **Obligaciones en vuelo.** Dinero ya cobrado y personas con entrada siguen servidas el tiempo necesario: webhooks, cron, reembolsos, confirmaciones, **y la puerta** (escáner) mientras existan eventos futuros con entradas vendidas. Parcial: ✔ API de dinero, ✘ página del escáner (MO-05).
5. **Transición, no corte seco.** `ACTIVE → WINDING_DOWN (ventas nuevas cerradas, obligaciones abiertas) → OFF`; el panel bloquea el paso a OFF si hay PENDING, eventos futuros con entradas, pedidos de tienda sin enviar, o sponsors con cobro pendiente, salvo anulación auditada con motivo (MO-11).
6. **Datos del cliente.** Antes de OFF: exportación disponible para el propietario; política explícita (retención N días en solo lectura, luego purga/anonimización de PII) y registro de qué se purgó; al reactivar, vuelven los datos salvo purgados.
7. **SEO/URLs.** Las URLs públicas del módulo salen del sitemap y devuelven 410/404 (o redirigen al inicio si hay sustituto); sin enlaces internos rotos.
8. **Roles.** Los roles que solo tenían ese módulo quedan inactivos (visibles como «inactivo», no asignables), no huérfanos ni con acceso residual.
9. **Propagación.** Publicar aplica en ≤15 s al servidor y ≤~90 s al HTML público cacheado; la ficha muestra «Cambios sin publicar»; el efecto en navegador abierto llega en la siguiente carga.
10. **Reversibilidad y auditoría.** Reactivar restaura el estado sin migraciones; todo cambio queda en auditoría con quién/cuándo/por qué.

---

## 5. Lo que ya está bien (con evidencia)

- **Default-deny por prefijo** con el más largo gana y segmentos exactos (`registry.ts:107-116`); un test enumera todas las `page|route` de `app/` y falla si falta dueño (`tests/lib/module-registry.test.ts:23-31`). Enumeración manual de los 147 ficheros `page.tsx`/`route.ts` de `app/` contra las reglas del registro: todos tienen dueño; la carpeta `app/api/patrocinadores` no contiene handlers.
- **Allowlist «nunca bloqueable»** (webhooks, cron, health, escáner/acceso API, lecturas de comprador, reembolso) en `registry.ts:143-156`, ejercitada en `gating.test.ts` (ACTIVE/GRACE/PANEL_BLOCKED/BLOCKED); el `PATCH` de pedidos se restringe dentro del handler (`app/api/admin/orders/[id]/route.ts:59` con `isFullAccessRestricted`).
- **Fases de licencia correctas y benévolas:** función pura (`contracts/src/license.ts`), avance por calendario solo con lectura fresca, un snapshot obsoleto nunca empeora la fase (`gating.test.ts:152-175`); panel con refresco diario y revocación de emergencia en segundos.
- **Menú del admin y navegación pública filtrados por módulos** con la misma función que el servidor (`isLinkVisible`), incluidos grupos vacíos (`admin-shell.tsx:129-134`); `wallets` exige entradas o tienda en el registro.
- **Dashboard por módulos del cliente** (`app/admin/page.tsx`), portada que degrada con módulos ausentes (`app/(public)/page.tsx:43-93`: sin Entradas no consulta eventos; CTA por módulo), sitemap/robots por módulos y dominio del cliente (`app/sitemap.ts`).
- **Config con dueño por clave** (`config-ownership.ts`): GET/PUT solo de módulos activos y del rol, con validación y todo-o-nada; secretos de solo escritura con máscara (`app/api/admin/config/route.ts:49-52,74`).
- **Cruces conocidos cerrados:** `withoutSeasonLink` y `seasonLinkEnabled` (`lib/modules/season-link.ts`), resumen de gastos y ventas/día condicionados, wallets 404 sin Entradas/Wallets, cuenta de cobro propia por módulo (`lib/payment-adapter.ts:528`), alta de TAQUILLA solo con Entradas.
- **Test genérico «módulo apagado = cero datos»** (`tests/tenant/module-off-zero-data.test.ts`) y `MODEL_OWNERS` que obliga a clasificar toda tabla nueva.
- **Sesiones revocables y rol de HOY** en cada lectura (`lib/auth.ts:62-90`) con degradación segura si la BD falla.
- **Cada cliente no hereda marca de otro:** valores por defecto de `lib/config.ts` y `brand.ts` condicionados por `isLegacyTenant`.

## 6. Límites de esta auditoría
No se ha renderizado ninguna pantalla ni se ha ejecutado test alguno; el contraste de MO-10 es cálculo sobre clases CSS. No se han revisado en profundidad las plantillas (Cine, Drop, Estudio…) salvo sus puntos de contacto con módulos. No hay acceso a red: precios de Harness no verificados. Los hallazgos del doc de revisión (2026-10-15) se verificaron solo si afectan a navegación/aislamiento; los de seguridad de módulos individuales (sponsors, dinero) pertenecen a otros informes.
