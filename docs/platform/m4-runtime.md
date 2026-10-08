# M4 · Runtime por Host

Un mismo despliegue del front sirve a varios clientes: cada Host resuelve a su cliente, que tiene su propia BD, su propio secreto de sesión y sus propias credenciales. Se activa con `PLATFORM_MODE=on` y **solo** en el proyecto de Vercel `platform`. Sin esa variable el front se comporta exactamente como hasta ahora (una BD, un `NEXTAUTH_SECRET`, un `NEXTAUTH_URL`).

## Cómo funciona

```
petición ──► middleware (edge) ──────────────────────────────► handler / página (Node)
             1. Host → registro firmado (Upstash)               lee el cliente de la cabecera firmada
             2. verifica firma, dominio, producto, replay       prisma  → BD del cliente (Proxy)
             3. suspendido → 503 (salvo webhooks y crons)       authOptions.secret → secreto del cliente
             4. Origin; sesión de staff con el secreto          getBaseUrl → dominio principal verificado
                DE ESE cliente
             5. cabecera x-grailla-ctx firmada (HMAC)
```

- **Registro:** el panel publica dos valores firmados con Ed25519 (`packages/contracts`): `h:{host}` (enrutado, sin secretos, lo lee el edge) y `s:{tenantId}:{producto}` (URLs de BD **selladas** `enc:v2`, solo se abren en Node). Etiquetas de firma distintas: uno no sirve como el otro.
- **Caché y caídas:** L1 en memoria de 15 s con jitter, negativa de 30 s y single-flight. Si el registro cae o devuelve algo inválido se sigue sirviendo lo último bueno (hasta 6 h), salvo que el dominio haya desaparecido del registro, que entonces se corta.
- **Contexto:** el middleware borra cualquier `x-grailla-ctx` que traiga el cliente y pone el suyo firmado con HMAC y con vida de 60 s. Lleva las URLs de BD selladas, no en claro. Así el cliente Prisma se crea de forma **síncrona** (hay dos `$transaction([...])` que no admiten un envoltorio asíncrono).
- **`prisma`** sigue importándose igual (~95 sitios) pero es un Proxy: cada acceso se resuelve contra el cliente de la petición y **lanza error si no hay ninguno**, sin caer nunca a `DATABASE_URL`. Un cliente Prisma por cliente (LRU por inactividad, `connection_limit` 3).
- **Cookie de sesión:** los clientes nuevos usan `__Host-next-auth.session-token` (sin `Domain`: un subdominio hermano no puede plantar una cookie del dominio padre); el cliente legacy conserva `__Secure-…` para no cerrar sesiones en el corte; en `*.localhost`, el nombre por defecto (`lib/tenant/session-cookie.ts`).
- **Sesión:** secreto por cliente = HKDF(`PLATFORM_SESSION_MASTER`, `{tenantId}:{época}`). La cookie de un cliente no abre otro; subir la época de un cliente cierra solo sus sesiones y enlaces. El token lleva `tid` (obligatorio salvo para el cliente legacy, cuyas sesiones previas no lo llevan). `useSecureCookies` va fijo (con la autodetección el nombre de la cookie depende de `x-forwarded-proto`).
- **Cliente legacy (La Grailla):** `LEGACY_TENANT_ID` + `LEGACY_NEXTAUTH_SECRET` conservan su secreto, sus enlaces ya enviados y sus `enc:v1`. Sigue **escribiendo** `enc:v1` (un rollback del código lo seguiría leyendo). Un cliente nuevo escribe `enc:v2` con su propio tenant en el AAD.
- **URLs absolutas** (emails, pagos, wallet, sitemap, robots): siempre del dominio principal verificado, nunca de cabeceras. En `*.localhost` usa http y el puerto.
- **ISR fuera:** las 8 páginas públicas pasan a `force-dynamic`; el CDN de Vercel las cachea 60 s por dominio (`Vercel-CDN-Cache-Control: max-age=60, stale-while-revalidate=30`) y el middleware añade `Vercel-Cache-Tag: t:{tenantId}:public` para poder purgar a un solo cliente. El build ya no muestra ninguna ruta `●`.

## Variables de entorno del proyecto `platform`

| Variable | Para qué |
|---|---|
| `PLATFORM_MODE=on` | Activa todo lo anterior |
| `PLATFORM_CONTEXT_KEY` | HMAC de la cabecera de contexto (32 bytes base64url) |
| `PLATFORM_SESSION_MASTER` | Maestro de los secretos de sesión y tokens por cliente |
| `SECRETS_KEYS`, `SECRETS_ACTIVE_KID` | **Los mismos maestros que el panel** (`{"m1":"…"}`): abren las URLs de BD y las credenciales `enc:v2` |
| `SNAPSHOT_PUBKEYS` | `{"s1":"<clave pública Ed25519>"}` del panel; varias a la vez permiten rotar |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Registro (token de **solo lectura** cuando se pueda) |
| `AUTH_TRUST_HOST=true` | next-auth deduce host y protocolo de `x-forwarded-*` |
| `LEGACY_TENANT_ID`, `LEGACY_NEXTAUTH_SECRET` | Cliente legacy (La Grailla) |
| `PLATFORM_PRODUCT` | Producto que sirve el despliegue (por defecto `grailla`) |

**Comando de build del proyecto `platform`: `npm run build:platform`** (solo `next build`). El `build` normal ejecuta `prisma migrate deploy`, que exige `DATABASE_URL`/`DIRECT_URL`; sin sobrescribirlo alguien acabaría definiendo esas variables globales «para que compile».

**No definir** `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET` ni `NEXTAUTH_URL` en ese proyecto. Una regla de ESLint prohíbe leerlos fuera de `lib/auth.ts`, `lib/url.ts` y `lib/tenant/installation-secret.ts`, y prohíbe capturar un delegado de `prisma` en ámbito de módulo.

## Probarlo en local

1. Panel con su registro de desarrollo: `npm run dev:registry` (en `apps/control-panel`).
2. Registrar clientes con `npm run tenant:register -- … --verified --publish` apuntando a BDs locales (ver `m3-control-panel.md`), p. ej. hosts `a.localhost` y `b.localhost`.
3. Front: variables de arriba más valores **señuelo** para las globales (`DATABASE_URL=postgresql://…@señuelo.invalid`, `NEXTAUTH_URL=https://nunca-usar.invalid`, `NEXTAUTH_SECRET=NUNCA-USAR…`) y `next dev`. Si algo aún dependiera de ellas, se vería.
4. `http://a.localhost:<puerto>` y `http://b.localhost:<puerto>` (Chrome resuelve `*.localhost`).

## Qué se comprobó

- **Tests:** 646 en la raíz y 113 en el panel, entre ellos los de aislamiento con **dos BDs reales** (`tests/tenant/`): handler real de `/api/events`, 300 peticiones intercaladas con transacciones, `$transaction([…])`, rotación de BD de un cliente, credenciales copiadas entre clientes, tokens, sesión y cookies, URLs, resolutor (replay, snapshot copiado bajo otro host, registro caído o manipulado) y middleware (cabecera falsificada, cookie de otro cliente, suspensión).
- **Dos fallos que solo salieron ejecutándolo de verdad**, con su arreglo: el middleware arrastraba `node:crypto`/`next/headers` al bundle edge (un 500 en todas las rutas; ahora un test vigila el grafo de imports del middleware), y `decryptSecret` asumía el tenant `legacy` en vez del cliente actual.
- **Navegador y curl, front real + panel real:** cada dominio sirve sus eventos y precios; login de admin en A; la cookie de A **no** abre `/admin` ni `/api/admin/*` de B (ni `getServerSession`), y viceversa; suspender B desde el panel da 503 en ≤ 15 s con el webhook sin bloquear, A intacto, y reactivar lo restablece.
- **Build de producción** del front: sin rutas ISR; el middleware compila para edge.
- **Modo normal:** toda la suite anterior pasa sin cambios.

## Revisión de seguridad (agente independiente, 8 oct 2026)

Se revisó el aislamiento con mentalidad adversarial; cada hallazgo se verificó contra el código antes de actuar. Arreglados, con test que falla sin el arreglo:

| # | Hallazgo | Arreglo |
|---|---|---|
| 1 (alto) | Avisos con destinatario **fijo** `grupolagrailla@gmail.com`: el formulario de patrocinio de cualquier cliente enviaba empresa, contacto, email, teléfono y mensaje a La Grailla; también el aviso de certificado de Apple y el de pagos sobre pedidos anulados; y `admin_email` heredaba esa dirección por defecto. | `getOperatorEmail()` (`lib/config.ts`): instalación única, La Grailla como siempre; modo plataforma, el `admin_email` **del cliente**, y vacío (no se envía) si no lo configuró. `admin_email` ya no tiene valor por defecto en modo plataforma. |
| 2 (medio) | El anti-replay del enrutado iba por host y el `seq` es por suscripción: un dominio reasignado de A (seq 50) a B (seq 3) se servía con la BD de A hasta 6 h (pedidos de B en la BD de A). | El replay se comprueba **después** de verificar, con clave `tenantId\|producto`; si el cliente verificado no coincide con el de la caché, jamás se sirve el contexto antiguo. |
| 3 (medio) | Sin backoff: con el registro caído cada petición reintentaba (3 s de espera). | Tras un fallo se sirve lo último bueno sin esperar y se reintenta cada ~5 s (`RETRY_BACKOFF_MS`); sin caché, el fallo también se recuerda. |
| 4 (medio) | Caché negativa sin tope y cada host desconocido costaba una lectura a Upstash (un dominio comodín podía inflar la memoria y gastar la cuota). | Tope de 10 000 entradas y cubeta de 100 + 20/s búsquedas por instancia para hosts sin caché. |
| 5 (medio) | El matcher cubría también los estáticos de `public/`: una invocación del edge por cada imagen. `stale-while-revalidate=300` era nuevo (hasta ~6 min de contenido viejo). | El matcher excluye `brand/`, `_next/static`, `_next/image` y los ficheros de imagen/worker de la raíz; `/api`, `/admin` y `/acceso` entran siempre, aunque acaben en `.png`. SWR a 30 s (≈ el ISR de antes). |
| 6 (bajo) | Cookie `__Secure-` sin `__Host-` (cookie tossing entre subdominios hermanos). | `__Host-` para clientes nuevos (ver arriba). |
| 8 (bajo) | GCM sin `authTagLength`: un tag truncado se aceptaba. | `authTagLength: 16` en v1 y v2. |
| 9 (bajo) | `build` exige `DATABASE_URL`. | `npm run build:platform` y documentado. |
| 10 (bajo) | `fromRequestHeader` tragaba `DynamicServerError`. | Se propaga. |

**Decisiones que se mantienen (documentadas, no son un olvido):**

- **Servir obsoleto ante una firma que no se puede verificar** (p. ej. una suspensión firmada con un `kid` desconocido tras una rotación mal desplegada) sigue sirviendo el último contexto bueno hasta 6 h: preferimos no apagar a todos los clientes por un error nuestro. Ahora queda en el log (`[tenant-resolve] sirviendo obsoleto …`) y hay que alertar sobre él. Lo que sí corta de inmediato es la **revocación de emergencia** (`revoked:{tenantId}`, M5).
- **La época del cliente legacy no revoca nada**: usa `LEGACY_NEXTAUTH_SECRET`, que ignora la época por diseño (para no invalidar sesiones y enlaces de La Grailla). Para cerrar sus sesiones hay que rotar ese secreto.
- **ESLint** prohíbe `process.env.DATABASE_URL` y similares con acceso directo; `process.env['DATABASE_URL']` o la desestructuración lo esquivan. Sin impacto hoy (el grep exhaustivo lo confirma); es un límite de la regla, no una garantía.
- El límite de búsquedas es por instancia (no global): el techo agregado en Upstash es instancias × 20/s.

## Pendiente (no es de M4)

- **Licencia por fases, módulos desactivados, dominio no verificado y revocación de emergencia** (la clave `revoked:{tenantId}` con TTL de pocos segundos): M5. El middleware ya tiene el punto de enganche (`isNeverBlockable`, `ctx.modules`, `ctx.status`).
- **`seq` persistente:** el anti-replay vive en la memoria de cada instancia; una instancia nueva acepta cualquier `seq` válido. Persistirlo (por cliente y producto) en el almacén hace falta antes del corte; el panel ya numera de forma monótona y **no debe reiniciarse**.
- **Crons por cliente** (hoy `reconcile-payments` y `cleanup-waiting-room` son workflows de GitHub con la URL de La Grailla y un único `CRON_SECRET`): M7.
- **Subidas a Blob desde el navegador** (`@vercel/blob/client`): el cliente elige la ruta; ya se validan contra la BD del cliente (ids cuid), pero llevarlas al prefijo `{tenantId}/` es de M6. Solo el `put` del servidor (`/api/admin/upload`) lo lleva ya.
- **Branding:** los textos, colores y logos siguen siendo los de La Grailla para todos los clientes (M6).
- **Medidas que necesitan Vercel/Neon reales** (spike M1): Ed25519/HKDF en el edge real, caché del CDN con dos dominios, arranque en frío de Neon, `waitUntil`, elección entre Edge Config y Upstash.
- **`next.config.js`**: la CSP sigue con `'unsafe-inline'`; sin cambios respecto a antes.
