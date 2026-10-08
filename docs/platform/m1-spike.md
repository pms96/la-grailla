# M1 · Spike go/no-go (8 oct 2026)

**Veredicto: GO con ajustes.** El runtime compartido por Host es viable con el cliente Prisma actual. Quedan 5 comprobaciones que solo se pueden hacer en un despliegue real de Vercel/Neon (ver "Pendiente").

Entorno de las medidas: Mac arm64, Node 26, Next 14.2.35, Postgres 16 en Docker (local, sin TLS ni red), esquema real de La Grailla (todos los modelos), 16 bases de datos de tenant. Código en `docs/platform/spike-m1/`. Las cifras de latencia son **de piso local**: no incluyen red, TLS ni el arranque de Neon.

## 1. Prisma por tenant

| Variante | Coste fijo 1.er cliente | Marginal por cliente extra (reposo) | 1.ª query de un tenant frío (p50 / p95) |
|---|---|---|---|
| A. 6.7 actual, motor librería, `datasources.url` | 10 MB | **1,2 MB** | 13 / 19 ms |
| B. 6.19.3 motor librería + `@prisma/adapter-pg` (`max: 2`) | 16 MB | 1,4 MB | 8 / 10 ms |
| C. 6.19.3 `engineType = "client"` (sin Rust) + adapter-pg | **43 MB** | 0,9 MB | 9 / 11 ms |

- 16 tenants en un proceso: 83 MB (A), 92 MB (B), 111 MB (C) de RSS pico.
- Con 300 ciclos de crear → 10 queries → `$disconnect` el RSS crece despacio: ≈0,06 MB/ciclo (A), 0,10 (B), 0,14 (C). No es una fuga grave, pero **conviene expulsar por inactividad (TTL), no por conteo**, y que el LRU sea holgado.
- Aislamiento: ninguna query devolvió datos de otro tenant en ninguna variante.
- **Conclusión:** la subida de Prisma **no es requisito**. El cliente actual ya admite un cliente por tenant con `datasources: { db: { url } }`. El motor sin Rust gasta *más* memoria fija con este esquema; no lo usamos por eso.
- Cada cliente de motor librería abre su pool: hay que poner `connection_limit` (se usó 2) en la URL, y los clientes retienen conexiones hasta `$disconnect`.
- Prisma 7 (7.10.0 estable; 8.0 sigue en RC) exige adapter, ESM, `prisma.config.ts`, y elimina `datasources`/`url` del schema (fuente: guía oficial de actualización a Prisma 7). No se hace ahora.

## 2. Contexto de tenant en Next 14.2

Probado en `next dev` y en `next build && next start`, con 2.400 peticiones concurrentes (40 y 80 en paralelo) intercalando 16 hosts. **0 mezclas.**

| Lugar | Cómo llega el tenant | Resultado |
|---|---|---|
| Route handler envuelto en `withTenant` (ALS propio) | `als.run` | Correcto, también tras `await` y dentro de `$transaction` |
| Server Component, `generateMetadata`, hijo en `<Suspense>` | cabecera `x-tenant-id` leída con `headers()` | Correcto (título, h1 y hijo en streaming del tenant correcto) |
| Trabajo tras la respuesta (`setTimeout` 150 ms) | ALS y `headers()` capturado | Funciona en `next start`. En Vercel hace falta `waitUntil` (Next 14.2 no tiene `after()`) |
| Temporizador creado fuera de cualquier petición | — | El Proxy de `prisma` **lanza error** (fail-closed) |
| Cliente que manda `x-tenant-id` falso | middleware borra y reescribe la cabecera | Se usa el del Host, no el enviado |
| Host desconocido | — | 404 desde el middleware |

- No se puede envolver un Server Component en un ALS propio. El diseño pasa a ser: **el middleware pone `x-tenant-id` (única fuente) y `currentTenantId()` = ALS si existe, si no `headers()`**.
- Trampa encontrada: usar el `prisma` global dentro de `prisma.$transaction(async (tx) => …)` pide una segunda conexión mientras la transacción retiene la primera. Con `connection_limit = 2` y concurrencia, las transacciones caducan (`Transaction already closed`, 74 errores en la prueba). Regla: dentro de la transacción solo `tx`. Añadir lint/test y subir `connection_limit` por tenant a ≥ 3 en el piloto.

## 3. Middleware (edge) y registro

- Ed25519 por WebCrypto en el middleware: verificación de snapshot **0,5–1,8 ms** en frío, ~0 con L1 (15 s). La caché L1 redujo 2.400 peticiones a 35 consultas al registro.
- HKDF por WebCrypto en el edge da **el mismo valor, bit a bit, que en Node** (secreto por tenant derivable en middleware y en el servidor).
- `@noble/ed25519` funciona como respaldo en el bundle del middleware (+≈3 KB; 17 ms la primera verificación).
- Lo medido es el sandbox edge de Next sobre Node, **no el edge real de Vercel** (ver Pendiente).

## 4. Sesión sin `NEXTAUTH_URL`

- Secreto por tenant (HKDF de un master + `tenantId`): la cookie de un tenant **no abre sesión** en otro.
- Sin `NEXTAUTH_URL` ni `AUTH_TRUST_HOST`: la URL base cae a `localhost:3000` (valida solo en local). Con `AUTH_TRUST_HOST` o `VERCEL`, deduce host y protocolo de `x-forwarded-*`.
- Con la autodetección, el nombre de cookie depende del protocolo de **esa** petición: login con `x-forwarded-proto: https` crea `__Secure-next-auth.session-token`, y una lectura de `getServerSession` sin esas cabeceras **no encuentra la sesión**.
- Con `useSecureCookies` fijo en las opciones por tenant, el nombre es determinista y login/lectura coinciden en los cuatro casos probados.
- Según el código de next-auth 4.x que citó la investigación, un `NEXTAUTH_URL` definido prevalece sobre el host detectado: **no debe existir** en el proyecto `platform`. `getToken()` en middleware debe recibir `secureCookie` explícito.

## 5. Investigación documental (fuentes en el informe del agente; 8 oct 2026)

- **Prisma:** driver adapters y motor sin Rust GA desde 6.16.0 (10 sep 2025; preview en 6.7–6.14). La doc no da cifra de memoria.
- **Neon:** proyectos por organización: Launch 100, Scale 1.000 (ampliable a petición). API: 700 req/min sostenidas, 40 req/s en ráfaga (dato de búsqueda, no leído entero). Pooler PgBouncer en modo transacción: 10.000 conexiones cliente; sin `SET`, `LISTEN/NOTIFY` ni advisory locks de sesión (los `xact` van dentro de la transacción). Scale-to-zero a los 5 min; reactivación "unos cientos de ms" sin cifra. UE: Frankfurt (`aws-eu-central-1`) y Londres. Neon recomienda proyecto por tenant para aislamiento y PITR independiente.
- **Vercel:** dominios por proyecto ilimitados en Pro (límite blando 100.000); alta por API con verificación TXT. Fluid compute: varias invocaciones comparten proceso, así que el estado global (mapa de clientes) es compartido. Middleware edge: 2 MB en Pro; soporte de Ed25519/HKDF en el edge **no documentado**.
- **CDN:** la clave de caché **incluye el Host**; las etiquetas (`Vercel-CDN-Cache-Tag`/`invalidateByTag`) son de alcance proyecto+entorno, **no por dominio**: hay que prefijarlas con el tenant (`t:<id>:…`). Disponible en todos los planes.
- **Registro:** Vercel Edge Config (según la doc consultada ahora "Global Config": 1 MB por store, propagación hasta ~10 s, lectura p50 0,34 ms) o Upstash Redis ($0,20/100k comandos, replicación asíncrona).

## 6. Cambios en el plan v3

1. **M2 ya no incluye subir Prisma.** Se queda en 6.7 (cliente por tenant con `datasources`). Se evalúa 6.19.x/7 más adelante por otras razones, no por este plan.
2. **`withTenant` + cabecera:** `x-tenant-id` puesta por el middleware es la fuente única; ALS solo para handlers/jobs.
3. **Regla de transacciones** (solo `tx` dentro) con lint y `connection_limit` ≥ 3.
4. **Sesión:** `useSecureCookies` fijo por tenant (https en producción) y `secureCookie` explícito en `getToken`. Sin `NEXTAUTH_URL` en `platform`.
5. **LRU de clientes por TTL de inactividad**, con `$disconnect` diferido.
6. **Registro:** el spike no decide entre Edge Config y Redis; con ≤ 1.000 registros de 1 KB cabe un store de Edge Config. Propuesta: Edge Config como principal y una clave de revocación en Redis solo si "pocos segundos" es requisito duro (propagación documentada ~10 s). Decidir tras medir en Vercel.
7. **Etiquetas de caché con prefijo de tenant**, porque la purga es por proyecto.

## Pendiente (requiere un despliegue real, no se puede probar en local)

1. Ed25519/HKDF en el edge **real** de Vercel (si falla: `@noble/ed25519`, ya probado).
2. Caché de CDN con `s-maxage` y purga por etiqueta con dos dominios en el mismo despliegue.
3. Arranque en frío de Neon (suspendido) y p95 de la primera query sobre la URL pooled con TLS.
4. `waitUntil` de `@vercel/functions` en Next 14.2 con trabajo tras la respuesta.
5. Latencia y propagación del registro elegido (Edge Config / Upstash) desde `fra1`.
