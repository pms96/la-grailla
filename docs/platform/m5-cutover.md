# Corte de La Grailla al proyecto `platform` (runbook)

La Grailla pasa de su proyecto de Vercel actual (modo normal, una BD) a un proyecto nuevo `platform` (`PLATFORM_MODE=on`) que la sirve como el cliente `legacy`. **El corte es mover el dominio** (segundos) y **el rollback es moverlo de vuelta**. El proyecto antiguo se deja caliente 4 semanas.

Nada de esto se ha ejecutado contra Vercel/Neon reales: lo que sigue es el procedimiento, con las comprobaciones que ya existen en el código. Lo que cambia respecto a hoy es solo *dónde* corre el código; la BD, el dominio, Stripe y los datos son los mismos.

## Lo que puede romper datos reales (no tocar)

Cambiar `HKDF_INFO` o la sal del proveedor legacy · el nombre de la cookie de sesión del legacy (`__Secure-next-auth.session-token`) · el valor de `NEXTAUTH_SECRET` del cliente 1 (va a `LEGACY_NEXTAUTH_SECRET` **idéntico**) · exigir `tid` a las sesiones legacy · cifrar `smtp_password` sin lector previo · sacar `migrate deploy` del build del proyecto *antiguo* antes de probar el runner (M7).

## 0. Antes de empezar (días antes)

- [ ] **Panel desplegado** (proyecto Vercel con *Root Directory* `apps/control-panel` y «Include source files outside of the Root Directory»), con su BD de control en Neon, claves propias (`SECRETS_KEYS` + `SECRETS_ACTIVE_KID` y `SNAPSHOT_SIGNING_KEY` + `SNAPSHOT_KID`) y una **regla de WAF / límite por IP en el login** (el panel solo limita por cuenta).
- [ ] **Registro** (Upstash Redis, región UE): un token de escritura para el panel y, si el plan lo permite, uno de **solo lectura** para el front.
- [ ] **Refresco diario de snapshots** programado: lo hace Vercel Cron del proyecto del panel (`apps/control-panel/vercel.json`, variable `CRON_SECRET`; ver `m7-operacion.md`), o `npm run snapshots:refresh` en `apps/control-panel` a mano. Sin él la fase de licencia deja de avanzar a las 168 h (ver `m5-modulos-licencia.md`). Para La Grailla, al no caducar, es lo que además mantiene `staleUntil` fresco.
- [ ] **Copia / punto de restauración** de la BD de La Grailla en Neon justo antes del corte.
- [ ] **Ventana sin eventos ni venta activa** (la sala de espera y los pagos en vuelo no deben cruzarse con el corte). Avisar al equipo.

## 1. Registrar La Grailla como cliente `legacy`

```bash
cd apps/control-panel
LAGRAILLA_DB_POOLED='…' LAGRAILLA_DB_DIRECT='…' \
npm run tenant:register -- --name "La Grailla" --host www.lagrailla.es \
  --modules tienda,entradas,contabilidad,wallets,sponsors \
  --pooled-env LAGRAILLA_DB_POOLED --direct-env LAGRAILLA_DB_DIRECT \
  --schema-version <última migración> --region aws-eu-central-1 --verified --publish
```

Anota el `tenantId` que imprime: es `LEGACY_TENANT_ID`. Sin vigencia fijada (`paidThrough` vacío) La Grailla **no caduca**. Si el dominio sin `www` también debe servirse, añádelo y verifícalo en el panel, y publica.

## 2. Proyecto `platform` en Vercel

Mismo repositorio. **Build Command: `npm run build:platform`**, región `fra1`. Variables (todas, y **ninguna más** de datos de un solo cliente):

| Variable | Valor |
|---|---|
| `PLATFORM_MODE` | `on` |
| `PLATFORM_CONTEXT_KEY`, `PLATFORM_SESSION_MASTER` | 32 bytes base64url **nuevos** (no reutilizar ninguno) |
| `SECRETS_KEYS`, `SECRETS_ACTIVE_KID` | **los mismos que el panel** |
| `SNAPSHOT_PUBKEYS` | clave(s) pública(s) Ed25519 del panel |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_READ_ONLY_TOKEN` | el registro (token de **solo lectura**; el de escritura es solo del panel) |
| `LEGACY_TENANT_ID` | el del paso 1 |
| `LEGACY_NEXTAUTH_SECRET` | **el valor actual de `NEXTAUTH_SECRET` de La Grailla, idéntico** |
| `AUTH_TRUST_HOST` | `true` |
| `CRON_SECRET` | el mismo que usan los workflows de GitHub (solo lo acepta el cliente legacy) |
| `PLATFORM_CRON_MASTER` | **M7.** El mismo valor que el panel: de él salen los secretos de cron de cada cliente |
| `BLOB_READ_WRITE_TOKEN` | el mismo almacén |

**No definir** `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET` ni `NEXTAUTH_URL`.

## 3. Comprobación previa (sin tocar nada)

Con las variables del paso 2 en el entorno (o con `vercel env pull`), desde la raíz:

```bash
npm run platform:preflight -- --host www.lagrailla.es --legacy \
  --expect-modules tienda,entradas,contabilidad,wallets,sponsors
```

Usa el mismo código que servirá las peticiones y **debe terminar en «Todo listo.»**: variables globales ausentes, claves bien formadas, el host resuelve con lectura fresca, cliente `ACTIVE` y licencia al día, módulos esperados, la BD abre con la URL sellada, las migraciones están aplicadas y **las credenciales `enc:v1` guardadas se descifran** con el secreto legacy. Cualquier ✗ = no hacer el corte.

Después, con un dominio de prueba **verificado como segundo dominio de La Grailla** apuntado al proyecto `platform` (p. ej. `plataforma.lagrailla.es`), recorrer a mano **solo lecturas**: portada, `/eventos`, un evento, `/tienda`, login de admin (la sesión de siempre debe abrirse: mismo secreto, cookie `__Secure-`), `/admin`, `/acceso`. No hacer compras ni escrituras con datos reales desde ahí.

## 4. El corte

1. Anotar la hora y el último pedido de cada tipo (referencia para el rollback).
2. En Vercel, **mover el dominio `www.lagrailla.es`** del proyecto antiguo al proyecto `platform`. (Si el DNS apunta a Vercel no cambia nada más; si no, cambiar el registro ahora.)
3. Comprobar en los primeros minutos: portada y eventos (200), login de admin con la sesión existente **sin volver a pedir contraseña**, `/admin`, escaneo en `/acceso`, un webhook de prueba de Stripe (desde el panel de Stripe, «enviar evento de prueba»; debe dar 2xx), y que `/api/cron/*` responde con el `CRON_SECRET` (lanzar a mano `GET /api/cron/dispatch?job=tenants` del panel con su `CRON_SECRET`, o uno de los workflows antiguos de GitHub).
4. Vigilar los logs del proyecto `platform` buscando `[tenant-resolve] sirviendo obsoleto` (el registro o una firma fallan) y errores de `TenantContextError`.

## 5. Rollback

Mover `www.lagrailla.es` de vuelta al proyecto antiguo. No hay nada que deshacer en datos: ambos proyectos usan la misma BD, el mismo `NEXTAUTH_SECRET` (en el nuevo, como `LEGACY_NEXTAUTH_SECRET`) y la misma cookie, así que las sesiones siguen valiendo en los dos sentidos. El proyecto nuevo sigue **escribiendo `enc:v1`** para el legacy a propósito, para que el antiguo pueda leerlo. Un cambio de variables en Vercel solo aplica con un nuevo despliegue: no sirve de rollback instantáneo; mover el dominio, sí.

## 6. Dos semanas de observación (criterio de salida de M5)

- Sin incidencias de sesión, de pagos ni de crons; ningún `sirviendo obsoleto` sin explicación; el refresco diario corriendo sin fallos.
- Solo entonces: dejar el proyecto antiguo en pausa (no borrarlo hasta las 4 semanas), y recién después se sacará `migrate deploy` del build del proyecto antiguo (`SKIP_MIGRATE_ON_BUILD=1`) y se retirarán los workflows `reconcile-payments.yml` y `cleanup-waiting-room.yml` en favor del disparador del panel (`m7-operacion.md`), una vez el runner de migraciones haya demostrado funcionar en un release real.

## Pendiente de medir en el entorno real

Hay una guía con sondas ejecutables para medirlo en un entorno de pruebas: [`m8-ensayo.md`](./m8-ensayo.md). Ed25519 y HKDF en el edge real de Vercel · caché del CDN con dos dominios y purga por etiqueta · arranque en frío de Neon · `waitUntil` · elección definitiva entre Edge Config y Upstash. Están en `m1-spike.md`; conviene hacerlos con el proyecto `platform` y un cliente de prueba **antes** de este corte.
