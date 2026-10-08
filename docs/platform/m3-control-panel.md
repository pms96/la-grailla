# M3 · Plano de control mínimo

App aparte en `apps/control-panel` (solo para el proveedor). Gestiona clientes, módulos y dominios, y **publica snapshots firmados** que el front compartido leerá en M4. La Grailla queda registrada como primer cliente.

## Qué hay

| Pieza | Dónde | Notas |
|---|---|---|
| Contrato compartido | `packages/contracts` | `RoutingRecord` (sin secretos), snapshot Ed25519, `enc:v2`, ULID, `normalizeHost`. Lo usan el panel y (en M4) el front. |
| BD de control | `apps/control-panel/prisma` | Operadores, sesiones, catálogo, `Tenant → Subscription → módulos/dominios`, `AuditLog`. Una BD propia, distinta de las de los clientes. |
| Acceso | contraseña + TOTP | Sesión en BD (hash del token), cookie `__Host-` en producción, inactividad 30 min, máximo 8 h. |
| Roles | `VIEWER`, `OPERATOR`, `BILLING`, `SUPERADMIN` | Cada servicio comprueba el permiso por dentro; las acciones del servidor vuelven a exigir sesión completa. |
| Auditoría | `AuditLog` | Solo inserción (trigger en BD) + cadena de hashes verificable desde la pantalla. |
| Publicación | `lib/services/snapshot.ts` | Un snapshot por dominio verificado, serializado por suscripción. |
| Registro | `lib/registry/store.ts` | Interfaz con `memory` (tests) y `upstash` (REST). La elección Edge Config / Upstash sigue abierta (ver spike M1). |

## Arrancarlo en local

```bash
cd apps/control-panel
cp .env.example .env          # y rellena claves (ver abajo)
npm install
npx prisma migrate deploy
npm run dev:registry          # registro de desarrollo compatible con Upstash (puerto 3113)
npm run operator:create -- --email tu@correo.es --name "Tu Nombre" --role SUPERADMIN
npm run dev                   # http://localhost:3200
```

- `SECRETS_KEYS` es un JSON `{"m1":"<32 bytes en base64url>"}` y `SECRETS_ACTIVE_KID` el kid activo. Rotar = añadir otro kid y activarlo; lo antiguo sigue abriéndose.
- `SNAPSHOT_SIGNING_KEY` es la clave Ed25519 (PKCS8, base64url). La pública correspondiente es lo que el front verificará.
- Tests: `npm test`. Usan una BD que **debe** terminar en `_test` (se niegan a correr contra otra) y claves efímeras.

### Registrar un cliente existente (p. ej. La Grailla como `legacy`)

```bash
LAGRAILLA_DB_POOLED=… LAGRAILLA_DB_DIRECT=… \
npm run tenant:register -- --name "La Grailla" --host www.lagrailla.es \
  --modules tienda,entradas,contabilidad,wallets,sponsors \
  --pooled-env LAGRAILLA_DB_POOLED --direct-env LAGRAILLA_DB_DIRECT \
  --schema-version 20260930110333_add_ingreso_model --verified --publish
```

Las URLs se leen de variables de entorno por nombre, nunca como argumento. El tenant `legacy` conserva sus `enc:v1`, su cookie y su secreto de sesión: M3 no los toca.

## Qué se comprobó

- **Tests:** 110 en el panel (servicios, auth, TOTP con vectores RFC 6238, carreras de login/recuperación/publicación/dominios, cadena de auditoría, origen) y 12 nuevos en la raíz/contrato (compatibilidad `enc:v2` panel↔front en los dos sentidos, vector dorado de firma contrastado con OpenSSL, atado del snapshot a host y producto).
- **Mutación:** quitar el advisory lock de la publicación hace fallar el test de concurrencia (`[1, 1]` en vez de `[1, 2]`).
- **Instalación en frío** desde los ficheros versionados: `npm ci`, `tsc`, tests y `next build` de producción correctos.
- **Navegador (local):** primer acceso completo (contraseña temporal → cambio obligatorio → QR/TOTP verificado con un cálculo independiente → códigos de recuperación → sesión), alta en lista, cambio de módulos → "Cambios sin publicar" → publicar → el registro recibe la v2 sin `wallets`, y verificación de la cadena de auditoría.

## Revisión de seguridad (agente independiente, 8 oct 2026)

Se revisó el código con mentalidad adversarial y se verificó cada hallazgo antes de actuar. Arreglados, con test:

| # | Hallazgo | Arreglo |
|---|---|---|
| 1 | El contador de fallos se contaba *después* de verificar: 40 códigos MFA en paralelo se comprobaban todos y la cuenta ni se bloqueaba. | Reserva atómica del intento en SQL **antes** de verificar (`reserveAttempt`): solo 5 intentos por ventana, en serie o en paralelo. La auditoría solo anota los que se verificaron (acotada). |
| 3 | Con la contraseña filtrada y sin TOTP se podía cambiarla y dejar fuera al dueño. | El cambio exige sesión con MFA, salvo el primer acceso. |
| 4 | Carrera en códigos de recuperación y hash SHA-256 de ~49 bits. | `array_remove` atómico; códigos de 16 caracteres (~79 bits). |
| 5 | Una firma válida no ataba el snapshot al dominio servido. | `verifySnapshot` exige `host` (y `product` opcional); `host_mismatch` / `product_mismatch`. |
| 6 | Liberar un dominio o suspender no tenía efecto hasta "Publicar" (fail-open). | Se republica solo; si el registro falla, el panel avisa. |
| 7 | Okupación de dominios sin verificar. | Los PENDING caducan a los 7 días y solo hay lápida si el dominio estuvo verificado. |
| 8 | Red dentro de la transacción de publicación. | Timeout de 8 s en el cliente del registro. |
| 10 | Un OPERATOR podía fijar la BD de un cliente al crearlo. | Crear cliente exige también `database:write`; BD remota sin TLS rechazada. |
| 11, 12 | Enumeración por tiempo; carrera del último superadmin. | Mismo trabajo en la ruta de email inexistente; lock en las operaciones sobre superadmins. |
| 13–16 | IP falsificable fuera de Vercel, sin HSTS, hash de auditoría sin IP/UA, verificación O(n) abierta a cualquiera, carrera al reclamar dominios, sesiones pre-MFA sin limpiar. | Corregidos (la verificación completa solo para quien administra operadores). |

Además, un middleware rechaza con 403 las peticiones que modifican datos desde otro origen o con `Origin: null`.

**No arreglado a propósito:**

- **Bloqueo remoto de una cuenta (#2).** Quien conozca el email puede bloquearla 15 min repitiendo contraseñas. Mitigado con `npm run operator:unlock` (desde el servidor) y por que la reserva acota el coste; el límite por IP real es una regla de WAF en el despliegue, no código del panel.
- **Re-autenticación en acciones críticas (#9)** y **ancla externa de la auditoría (#14)**: umbral posterior.
- **Una publicación que falle justo después de escribir en el registro** (#8, residual) puede dejar un `seq` huérfano; el siguiente publish lo reutiliza. Muy poco probable y inocuo, porque el lector acepta `seq` iguales.
- **CSP con `unsafe-inline`** en producción: Next 14 sin nonce.
- **`seq` persistente en el front y revocación de emergencia:** son del lector (M4). Ya está documentado en el contrato que debe persistirlo.

## Decisiones y desvíos respecto al plan

1. **MFA con TOTP + códigos de recuperación, no passkey.** Se puede probar de punta a punta aquí y no añade dependencias. Las passkeys quedan para antes de tener más de un operador.
2. **Sin workspaces de npm.** Hay dos lockfiles sincronizados en la raíz y no se sabe con cuál instala Vercel; el panel tiene el suyo. Importa `@grailla/contracts` por ruta relativa (`externalDir`) y fuerza su `zod` por alias de webpack.
3. **La licencia por fases (7/15/22 días) no está aquí.** El snapshot publica siempre `ACTIVE`; el cálculo de fases es M5.
4. **No hay borrado de clientes ni "revelar credenciales".** Las URLs de BD solo se pueden sustituir (SUPERADMIN), nunca ver.
5. **Verificación de dominio:** TXT `_grailla-verify.<host>`, o manual (solo SUPERADMIN, auditada). Un dominio liberado queda reservado 30 días.

## Límites conocidos (antes de exponerlo a Internet)

- No hay limitación por IP en el login: solo bloqueo por cuenta (5 intentos → 15 min). Poner una regla de WAF/Vercel Firewall delante antes de exponerlo. `npm run operator:unlock -- --email …` levanta un bloqueo desde el servidor.
- La auditoría vive en la misma BD que el panel: el trigger impide editarla desde la app, no a quien tenga el rol propietario de la BD. Separar roles de BD y anclar la cadena fuera es de umbral posterior.
- Los snapshots caducan "en blando" a las 168 h (`SNAPSHOT_STALE_HOURS`): hace falta un refresco periódico (M7).
- Despliegue en Vercel: proyecto nuevo con *Root Directory* `apps/control-panel` y "Include source files outside of the Root Directory" activado (por `packages/contracts`).
