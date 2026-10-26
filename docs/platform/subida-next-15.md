# Subida de Next 14.2.35 a Next 15.5.28

Solo el **front** de la raíz. Sin migraciones, sin cambios de esquema, sin features. El panel (`apps/control-panel`) **no** se toca: sigue en Next 14.2.35 y es otro proyecto de Vercel.

## Versiones

| Paquete | Antes | Ahora |
|---|---|---|
| `next` | 14.2.35 | **15.5.28** (última 15.5.x; no está deprecada y `npm audit` no le atribuye ningún aviso propio, solo el `postcss` 8.4.31 que lleva dentro, igual que antes) |
| `eslint-config-next` | 14.2.35 | 15.5.28 |
| `@next/swc-wasm-nodejs` | 13.5.1 | 15.5.28 (solo el respaldo wasm; que siga el número de Next) |
| `react`, `react-dom` | 18.2.0 | **18.2.0 (sin cambio)** |
| `@types/react`, `@types/react-dom` | 18.2.22 / 18.2.7 | sin cambio |

Del lockfile solo cambian los paquetes de Next (SWC, `@next/env`, `styled-jsx`, `@swc/helpers`) y aparece `sharp` (dependencia opcional de Next; no se usa: `images.unoptimized`). `next-auth` 4.24.11 y `@vercel/blob` no se tocan: next-auth ya hace `await` de `params`, `headers()` y `cookies()` y declara `next ^15` en sus peers. No hay Sentry ni `@next/third-parties`.

## React 18 o 19: se queda en 18

- Next 15.5 admite `react ^18.2 || ^19` como peer, así que 18.2 es válido.
- El App Router **no usa el React instalado**: Next 15 trae su propio React 19 (`19.2.0-canary`) y lo enlaza en los bundles del servidor y del cliente. Igual que Next 14 traía el suyo 18.3 canary. Instalar 19 solo cambiaría los tipos y el resto de dependencias que se resuelven fuera de ese alias.
- Pasar a 19 de verdad obliga a subir a la vez `@headlessui/react` 1.7, `@tanstack/react-query` 5.0, `cmdk`, `embla-carousel-react`, `framer-motion` 10 y otras que declaran peers `^18` (`npm install --dry-run` da ERESOLVE en todas): una segunda migración con su propio riesgo. No es necesaria para esta subida.
- Consecuencia práctica: en el navegador el runtime ya es React 19 canary. Se comprobó en producción (build + `next start`) que se hidratan y funcionan el panel, la taquilla (`/acceso`), la compra, un diálogo de Radix y las gráficas, sin errores de consola. Como `@types/react` sigue en 18, no existe `use()` en los tipos: una página cliente con `params` (`/admin/sponsors/[id]`) usa `useParams()`.

## Qué cambió en el código (100 ficheros)

| Categoría | Ficheros | Detalle |
|---|---|---|
| Dependencias | 2 | `package.json`, `package-lock.json` |
| `params` / `searchParams` asíncronos | 55 en `app/` | Codemod oficial `@next/codemod@15.5.28 next-async-request-api`: route handlers y páginas pasan a `props.params: Promise<…>` con `await`; sin ninguna marca `@next-codemod-error` |
| Páginas cliente | 1 | `app/admin/sponsors/[id]/page.tsx`: `useParams()` en vez de `params` (ver arriba) |
| next-auth | 1 | `app/api/auth/[...nextauth]/route.ts`: el tipo del contexto pasa a `params: Promise<…>` (next-auth ya lo espera) |
| Contexto del cliente | 1 | `lib/tenant/context.ts`: `headers()` con `UnsafeUnwrappedHeaders` (ver más abajo) |
| Docs | 1 | Este documento |
| Tests | 39 | `params: Promise.resolve({…})` al llamar a los handlers y páginas, y el mensaje de `notFound()` (`NEXT_HTTP_ERROR_FALLBACK;404`). Ninguna aserción se ha relajado |

No hacía falta tocar `next.config.js`, `middleware.ts`, `next/image`, `next/font`, `fetch` del servidor ni `next/dynamic`.

## Aislamiento por Host bajo Next 15

- El contexto del cliente llega en la cabecera firmada `x-grailla-ctx` y se lee con `headers()` **de forma síncrona** (`prisma` es un Proxy síncrono, ~95 sitios y dos `$transaction([...])`). Next 15 sigue permitiendo el acceso síncrono (con un aviso solo en `next dev`), y el codemod lo marca con `UnsafeUnwrappedHeaders`. Se mantiene el fail-closed: sin cabecera válida, `prisma` lanza.
- Tests (164 archivos, 1443 tests, los mismos que antes), incluidos los de dos BDs y el que recorre todos los `route.ts` exigiendo contexto de cliente.
- Prueba real con `next start` y registro de desarrollo (3 clientes con BDs distintas; hosts `a.cliente.es` y `b.cliente.es` por cabecera `Host`, `c.localhost` en el navegador): 118 comprobaciones (portada, `/eventos`, ficha, `/tienda`, ficha de producto, `/api/*`, `generateMetadata`, rutas con `params`, módulos apagados, host desconocido, login de admin, cookie de A contra B, id de A contra B) con resultado idéntico a Next 14 salvo la cabecera `Cache-Control` de `/api/health` (Next 14 la duplicaba: `private, no-store, no-store`) y las fechas de expiración de sesión. 400 peticiones concurrentes e intercaladas A/B sin ninguna fuga.
- Política de caché: la tabla de rutas del build es idéntica (150 rutas, todas `ƒ`, ninguna `○`/`●`), la raíz y las públicas siguen `force-dynamic`, siguen `Vercel-CDN-Cache-Control: max-age=60, stale-while-revalidate=30` y `Vercel-Cache-Tag`, y el `Cache-Control: private, no-store` del middleware se mantiene. El nuevo valor por defecto de Next 15 (`fetch` y GET de route handlers sin caché) no cambia nada: no había ningún GET estático y los `fetch` del servidor son de pagos/Wallet/logos.
- Modo normal (sin `PLATFORM_MODE`): mismas respuestas que antes en portada, eventos, tienda, salud, `/admin` y API de staff.

## Riesgos residuales (de más a menos)

1. **Next 16 no se puede subir sin rediseñar `lib/tenant/context.ts`.** Next 16 elimina el acceso síncrono a `headers()`; habrá que resolver el contexto con `await` en cada punto de entrada y propagarlo con `AsyncLocalStorage` (o equivalente) en vez de leerlo dentro del Proxy síncrono de `prisma`. Es la deuda real que deja esta subida. Dentro de 15.x funciona y está probado.
2. **React 19 en el cliente con librerías pensadas para 18.** El runtime ya lo es (ver arriba) y las pantallas probadas van bien, pero no se han recorrido a mano todas las pantallas del panel (react-day-picker, framer-motion 10, vaul, cmdk, recharts, input-otp, scanner con cámara: la cámara no se pudo probar en el navegador de pruebas). Conviene un repaso manual en el entorno de pruebas.
3. **Ruido en `next dev`**: cada ruta imprime `headers() should be awaited` una vez. Solo en desarrollo; no afecta a producción.
4. **`next lint`** funciona pero Next 15.5 ya lo da por deprecado (desaparece en 16); migrar a ESLint CLI cuando se suba a 16.
5. **Descargas de Google Fonts en el build** (`next/font`): en las pruebas el build con Next 14 falló una vez por un fallo intermitente del cargador de fuentes y pasó al reintentar; con Next 15 no ocurrió. Si el build de Vercel falla por «Failed to fetch … from Google Fonts», es un reintento.
6. Fuera de alcance pero visto: `npm audit` marca `next-auth` 4.24.11 (corregido en 4.24.15), `postcss` interno de Next, `nodemailer` y `uuid`. No se han tocado.

## Despliegue y vuelta atrás

1. **No se puede probar el tráfico real en un Preview**: las vistas previas (`VERCEL_ENV=preview`) responden 404 a propósito (`m7-operacion.md`, apartado 6). Un Preview solo sirve para comprobar que el **build** pasa. El ensayo funcional se hace como se describe en `m8-ensayo.md` (proyecto `platform-pruebas` desplegado como Production con dos clientes de prueba) o, antes, en local con el procedimiento de `m4-runtime.md` («Probarlo en local») y `next build` + `next start`.
2. Orden sugerido: (a) revisar y hacer commit de esta rama; (b) desplegar a `platform-pruebas` y repetir las comprobaciones de dos hosts (portada, evento, tienda, login de admin, cookie cruzada, `/api/health` con el secreto de cron); (c) recorrer a mano el panel y la taquilla (riesgo 2); (d) producción.
3. **Un push a `plataforma` también lanza el Preview del proyecto antiguo `la-grailla`, que ejecuta `prisma migrate deploy` (`npm run build`)**. Esta subida no lleva migraciones, así que no aplicará nada; compila el front también en modo normal con Next 15 (comprobado en local).
4. **Vuelta atrás**: en Vercel, «Instant Rollback» al despliegue anterior de `grailla-platform` (y del proyecto antiguo si procede); o `git revert` del commit. No hay migraciones, registro ni claves que deshacer. Los tokens de sesión y las cookies no cambian (mismos secretos, mismos nombres), así que las sesiones abiertas siguen valiendo en los dos sentidos.

## Configuración manual

- Vercel, proyectos `grailla-platform` y el antiguo `la-grailla`: **Node.js Version 22.x** (Next 15.5 exige ≥ 18.18; el `.nvmrc` y la CI ya usan 22). Comprobar el ajuste, no cambia nada si ya está.
- Nada más: ni variables nuevas, ni cambios en Sentry (no se usa), ni en el panel.

## Cómo se probó

`npx tsc --noEmit`, ESLint con la misma configuración que `next lint` (0 errores; las mismas 12 advertencias de antes), `TZ=UTC npx vitest run` (164 archivos, 1443 tests), `npm run check:migrations`, `next build` (con `SKIP_MIGRATE_ON_BUILD=1` y la BD local de pruebas), `next start` con el registro de desarrollo y tres clientes, y comparación con un build de la línea base (Next 14.2.35) servido con las mismas BDs y el mismo registro.

Nota de entorno: dentro de un worktree anidado en el repo, `next lint` y el lint del `next build` chocan con el `.eslintrc.json` del repo padre (`Plugin "@next/next" was conflicted`); no ocurre en un clon normal ni en Vercel. En esas pruebas se usó `eslint --no-eslintrc -c .eslintrc.json` y `next build --no-lint`.
