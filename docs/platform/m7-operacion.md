# M7 · Listo para el cliente 2: operación

Criterio de salida del hito: **dar de alta un cliente de prueba de punta a punta sin tocar código.** Se ha hecho en local con el front real en modo plataforma: un solo comando crea la BD, migra, siembra, verifica el dominio, publica y comprueba la salud; la web del cliente responde en su dominio y su administrador entra con la contraseña generada (ver «Verificado»).

Lo que NO se ha podido probar aquí (necesita Vercel/Neon/GitHub reales) está al final.

## Qué hay

| Pieza | Dónde | Para qué |
|---|---|---|
| Runner de migraciones | `apps/control-panel/lib/services/migrations.ts` · `npm run migrate:tenants` | Aplica las migraciones del front a la BD de cada cliente, con parada ante fallo, `lock_timeout` y reintentos |
| Alta por script, idempotente | `lib/services/provision.ts` · `npm run tenant:provision` / `tenant:go-live` | BD → registrar → migrar → sembrar → verificar dominio → publicar → comprobar salud |
| Disparador de crons por cliente | `lib/services/crons.ts` · `GET /api/cron/dispatch` · `apps/control-panel/vercel.json` (Vercel Cron) | Un solo disparador recorre los clientes con el secreto de cada uno |
| Salud básica | front `GET /api/health` · panel `/health` y ficha del cliente | Última comprobación, esquema aplicado/declarado, tareas, onboarding |
| Copia cifrada del registro | `lib/services/registry-export.ts` · `npm run registry:export` / `registry:import` | Segunda red de seguridad, fuera de la plataforma |
| Puerta por versión de esquema | `lib/platform/min-schema.ts` + middleware | Un cliente atrasado ve mantenimiento **solo él** |
| Build sin migrar | `scripts/build.js` · `SKIP_MIGRATE_ON_BUILD=1` | `migrate deploy` fuera del build, reversible |
| Cola de reconciliación justa | migración `20261009090000_reconcile_queue` | Los pedidos atascados ya no bloquean a los nuevos |

## Variables de entorno nuevas

| Variable | Dónde | Valor |
|---|---|---|
| `PLATFORM_CRON_MASTER` | front **y** panel | 32 bytes base64url, **el mismo** en los dos. Distinto de cualquier otra clave. El secreto de cron de un cliente es `HMAC(maestro, tenantId)` |
| `CRON_SECRET` | proyecto Vercel del **panel** | ≥ 24 caracteres aleatorios. Vercel Cron lo envía solo en `Authorization: Bearer …` a cada ejecución; con él se autentica el disparador. `PANEL_CRON_SECRET` se acepta como alternativa para llamadas manuales con `curl` |
| `REGISTRY_EXPORT_KEY` | donde se ejecute `registry:export` | 32 bytes base64url, **distinta de las demás**, guardada aparte del fichero |
| `FRONT_PRISMA_DIR` | panel (opcional) | Carpeta `prisma/` del front; por defecto `../../prisma` |
| `TENANT_URL_TEMPLATE` | panel (solo desarrollo) | p. ej. `http://{host}:57811`; por defecto `https://{host}` |
| `CRON_BUDGET_MS` | panel (opcional) | Presupuesto de una invocación del disparador (90 000 por defecto, con `maxDuration = 120`). **No lo bajes de 30 000**: una llamada a un cliente puede tardar hasta 20 s y no se lanza ninguna que no quepa |
| `SKIP_MIGRATE_ON_BUILD=1` | proyecto de Vercel del front (opcional) | El `build` no migra |

## 1 · Dar de alta un cliente

Requisitos: la BD del cliente ya creada (un proyecto de Neon por cliente, región UE) y sus dos URLs (pooled y directa) en variables de entorno **de tu shell** (nunca como argumento: quedarían en `ps` y en el historial). Los textos legales los aporta el cliente, en una carpeta con `aviso-legal.txt`, `privacidad.txt` y `cookies.txt`.

**Una BD por cliente, y nunca la de otro.** El alta se niega, antes de registrar, migrar o sembrar nada, si la BD:
- ya tiene la marca de **otro** cliente (`AppConfig.platform_tenant_id`; se escribe al sembrar) — nunca, ni con `--adopt-database`;
- tiene datos (usuarios, pedidos, eventos) y no está marcada — solo con `--adopt-database`, para adoptar a propósito un cliente que ya existía; al adoptar no se crea ningún administrador nuevo;
- ya está registrada en otro cliente (la huella servidor+puerto+nombre es única en el registro), o las URLs con pooler y directa son de servidores distintos de Neon.

Un front que sirve a un cliente cuya BD está marcada como de otro lo dice en `/api/health` (503, y el panel lo marca como «LA BD ES DE OTRO CLIENTE»). «Sustituir las URLs» desde el panel hace las mismas comprobaciones y **publica al momento** (antes el front seguía usando la BD antigua hasta el refresco diario).

```bash
cd apps/control-panel
BARPEPE_POOLED='postgresql://…' BARPEPE_DIRECT='postgresql://…' \
npm run tenant:provision -- --name "Bar Pepe" --host www.barpepe.es --modules tienda,entradas \
  --admin-email pepe@barpepe.es --legal-dir ./legales/barpepe \
  --database-existing --pooled-env BARPEPE_POOLED --direct-env BARPEPE_DIRECT \
  --domain dns --credentials-file ./credenciales-barpepe.txt --check-health
```

Cada paso es **idempotente**: si se corta, se repite el mismo comando y continúa (no crea un segundo cliente, no vuelve a migrar lo ya migrado, no cambia una contraseña ya creada, no republica si no hay cambios).

| Paso | Qué hace |
|---|---|
| `database` | Con `--database-local` crea la BD en el Postgres local (solo desarrollo); con `--database-existing` usa la indicada |
| `register` | Crea cliente, suscripción, módulos y dominio (o reutiliza si el dominio ya es de un cliente con ese nombre; si es de otro, falla) |
| `migrate` | El mismo runner del lote (con linter) |
| `seed` | `admin_email`, textos legales y el primer ADMIN con una contraseña aleatoria. Nunca siembra credenciales (rechaza claves de aspecto secreto) |
| `onboarding` | Lee de **la BD del cliente** si están `admin_email` y los tres textos legales |
| `domain` | `dns`: comprueba el TXT `_grailla-verify.<host>`; `manual`: lo da por verificado (SUPERADMIN); `pending`: lo deja pendiente y muestra el TXT que debe crear el cliente |
| `publish` | Firma y publica el registro |
| `health` | Con `--check-health`, llama al front real con el secreto del cliente |

**Datos mínimos obligatorios para publicar:** `admin_email` y los tres textos legales. Sin ellos el alta se **rechaza antes de tocar nada**; con `--allow-incomplete` se da de alta pero no se verifica el dominio ni se publica (la web no existe para el público). Cuando el cliente los complete desde su panel (o tú desde la BD), `npm run tenant:go-live -- --subscription <id> --domain dns` vuelve a comprobarlos en su BD, verifica el dominio y publica.

La contraseña inicial se muestra **una vez, en cuanto se crea el usuario** (antes de los pasos que pueden fallar: si algo falla después, ya la tienes; repetir el comando no la vuelve a mostrar). Repetir un alta con **otra URL de BD** falla en voz alta (`database_mismatch`): para corregir una URL equivocada usa «Sustituir las URLs de conexión» en la ficha del cliente. Se muestra (o se guarda en `--credentials-file` con permisos 0600, que no se sobrescribe). Entrégala al cliente por un canal seguro y bórrala; el cliente debe cambiarla al entrar.

Para un cliente nuevo, el panel de administración del cliente muestra «Completa estos datos antes de publicar la web» mientras falte algo.

## 2 · Migrar las BDs de los clientes

**Orden obligatorio de un release con migración:** (1) CI verde (el linter solo admite migraciones aditivas), (2) `migrate:tenants --dry-run`, (3) `migrate:tenants` (con un cliente canario primero), (4) desplegar el front. Las migraciones son aditivas: el front anterior sigue funcionando con la BD nueva.

```bash
cd apps/control-panel
npm run migrate:tenants -- --dry-run                       # qué haría, y el linter
npm run migrate:tenants -- --canary <subscriptionId>       # el canario primero; si falla, nadie más
npm run migrate:tenants                                    # todos (concurrencia 5)
```

- **Concurrencia** 5 (máx. 10). **Parada ante el primer fallo:** los clientes que no llegaron a lanzarse quedan `SKIPPED` y no se tocan (`--continue-on-failure` lo desactiva).
- **`lock_timeout` de 3 s** durante la migración, puesto **solo en la conexión del runner** (`options=-c lock_timeout=3000` en la URL directa: parámetro de arranque de Postgres que el motor de Prisma respeta; se comprobó). No se toca la BD del cliente: sus conexiones normales (ventas y taquilla esperan bloqueos de asesoramiento hasta 20 s) no heredan los 3 s, y no queda nada que restaurar si el runner muere. Plan B si algún proveedor rechazara ese parámetro: `MIGRATION_LOCK_TIMEOUT_MODE=database` vuelve a `ALTER DATABASE … SET` (afecta a toda la BD mientras dura; exige ser su propietario). Hasta 3 intentos y espera creciente si Postgres aborta la migración por un bloqueo. Esa migración se deshizo entera (Postgres la ejecuta como una sola transacción), así que se marca como revertida y se reintenta. Un fallo que **no** es de bloqueo no se reintenta: la migración fallida queda a la vista y la siguiente ejecución exige que una persona la resuelva (`prisma migrate resolve`).
- **Linter:** las migraciones posteriores a la línea base deben ser aditivas; una destructiva solo se aplica con `--allow-destructive` (queda en la auditoría), **aunque lleve el marcador `-- allow-destructive:`** (el marcador sirve para pasar la CI; aplicarla a todos los clientes exige además la bandera). `BEGIN/COMMIT` y `CONCURRENTLY` dentro de una migración **no se aplican nunca**: una transacción explícita rompería la garantía de que un aborto la deshace entera. Hazlo únicamente en un release «contract», tras un PITR y cuando ningún despliegue ejecute ya el código antiguo.
- **Al terminar** actualiza `schemaVersion` del cliente y **republica** su registro: el front ya puede servirlo con el código que exige esa versión (`FRONT_MIN_SCHEMA`).
- **Si la BD ya está al día pero el registro no** (alta sobre una BD ya migrada, o un runner que murió tras aplicar), el runner **sincroniza `schemaVersion` y republica** aunque no haya nada pendiente. Un `--dry-run` no lo hace. Si no puede republicar, `migrate:tenants` termina con error (el cliente podría quedar en mantenimiento).
- Cada ejecución queda en `MigrationRun` (sin URLs ni credenciales) y en la auditoría; se ven en la ficha del cliente y en `/health`.
- No hay «down»: se corrige hacia delante y se hace PITR antes de cualquier «contract».
- `CREATE INDEX CONCURRENTLY` no puede ir en una migración de Prisma (va en una transacción): se hace como paso aparte.
- **Ventana sin venta online activa:** el runner no la conoce. Para cualquier migración que tome bloqueos largos, ejecútalo fuera de horas de venta.

> **El runner no corre en CI.** Necesita `SECRETS_KEYS` (con la que se abren las URLs de BD de todos los clientes). Darle esa clave a GitHub Actions es una decisión de confianza que no he tomado por ti: ejecútalo desde una máquina de operación o, si lo decides, desde un runner con esos secretos.

### Sacar `migrate deploy` del build (cuando toque)

`npm run build` sigue migrando como hasta ahora. En el proyecto `platform` (`PLATFORM_MODE=on`) **nunca** migra. Para el proyecto actual de La Grailla, el interruptor es **`SKIP_MIGRATE_ON_BUILD=1`** en las variables de Vercel (quitarla lo revierte). Hazlo **solo cuando** el runner haya migrado a La Grailla en un release real y lleve las dos semanas de observación del corte. No lo hagas antes: si el runner falla ese día, el despliegue ya no arreglaría el esquema.

### Puerta por versión de esquema (`FRONT_MIN_SCHEMA`)

`lib/platform/min-schema.ts` guarda la migración más nueva que necesita el código de este build. **Se sube a mano, en el release que empieza a usar una columna o tabla nueva.** Si el `schemaVersion` del registro de un cliente es anterior (o desconocido), solo ese cliente recibe `503 Cliente en mantenimiento` (`Retry-After: 30`); `/api/health` sigue respondiendo. Un `schemaVersion` null cuenta como atrasado: **un cliente registrado sin versión de esquema no se sirve** (el preflight lo detecta; y el alta y el runner lo rellenan solos). Desde fuera, `/api/health` público responde **503 `{status:"maintenance"}`** en ese caso (no «ok»), y el panel marca al cliente como «Falla». Los webhooks y crons de un cliente atrasado también reciben 503: los proveedores de pago reintentan, y un handler sobre un esquema que no conoce podría escribir mal.

## 3 · Crons por cliente

**Vercel Cron** (`apps/control-panel/vercel.json`, solo corre en el despliegue de producción del proyecto del panel; requiere plan Pro para ejecutarse cada 5 min) llama cada 5 minutos a `GET /api/cron/dispatch?job=tenants` y una vez al día (04:17 UTC) a `?job=snapshots-refresh`. Vercel envía `Authorization: Bearer $CRON_SECRET` por su cuenta. Sustituye al workflow de GitHub (`platform-crons.yml`, eliminado): GitHub puede retrasar o saltarse ejecuciones programadas, y aquí hay cobros de SumUp que solo esta tarea confirma.

**La ejecución falla (HTTP 500) si alguna tarea de un cliente falla** o si había tareas vencidas y no se lanzó ninguna: se ve en la pestaña Cron Jobs de Vercel y en el log. Cada fallo deja una línea `[cron-dispatch] <tarea> falló para el cliente <id> (<host>)`. Vercel **no avisa** por sí solo de un cron fallido: hace falta un monitor externo (ver «Observabilidad mínima» en el plan de puesta en producción).

- El panel recorre los clientes **publicados** (activos o suspendidos; un cliente suspendido sigue reconciliando sus cobros en vuelo) y llama a cada tarea con el secreto de **ese** cliente. No sigue redirecciones (el secreto va en una cabecera).
- Tareas: `reconcile-payments` (5 min), `cleanup-waiting-room` (30 min), `health` (5 min). El backoff de `reconcile-payments` se queda en **15 min** como máximo (SumUp no tiene webhook: es lo que confirma un cobro); el de la limpieza, en 1 h.
- No se lanza una llamada que pudiera acabar pasado el presupuesto (`CRON_BUDGET_MS` menos el tiempo máximo de la llamada, 20 s). Con un presupuesto menor de 20 s el disparador no llamaría a nadie: ahora lo dice (responde 500 y lo registra) en lugar de «pasar» en verde.
- Sin `CRON_SECRET` (o `PANEL_CRON_SECRET`) el disparador responde 401, igual que con un secreto equivocado (no revela la configuración); el fallo se registra en el log del panel.
- Un fallo inesperado de un cliente (p. ej. la BD de control al guardar su salud) cuenta como fallo de **ese** cliente y tarea: queda anotado con su backoff y no aborta la pasada de los demás.
- Estado por cliente y tarea en `CronState`: un cliente que falla se **espacia solo** (backoff exponencial hasta 1 h) y no frena a los demás; no hay «cabeza de cola». La tarea de salud no se espacia.
- **Presupuesto de tiempo** por invocación (`CRON_BUDGET_MS`): lo que no cabe queda para la siguiente, y se atiende primero lo que lleva más sin ejecutarse.
- **`snapshots-refresh` es obligatorio a diario**: sin él la fase de licencia deja de avanzar a las 168 h. `/health` avisa si un registro lleva más de 36 h sin republicarse.

**Retirar los workflows antiguos** (`reconcile-payments.yml`, `cleanup-waiting-room.yml`, que llaman a `www.lagrailla.es` con un único secreto) **cuando** el proyecto `platform` sirva La Grailla y el disparador nuevo lleve unos días sin errores. Mientras coexistan no hacen daño: las tareas son idempotentes (el cliente legacy acepta el `CRON_SECRET` global justo para esto).

Plan de Vercel: el panel necesita **Pro** (Vercel Cron cada 5 min y funciones de 120 s). En Hobby los crons solo pueden ser diarios y una función dura 10 s: el disparador no serviría.

## 4 · Salud

- Front `GET /api/health`: público devuelve solo `{status}` (200/503). Con el secreto de cron del cliente devuelve el detalle: versión, BD (latencia), esquema aplicado/esperado/mínimo, onboarding. Se sirve también con el cliente suspendido, en mantenimiento o sin licencia.
- Panel `/health`: una fila por cliente, lo que falla primero. Señala: no responde, BD caída, esquema atrasado, **deriva** (el registro declara una versión y la BD tiene otra), datos sin completar, tarea fallando 3 veces seguidas, última migración fallida, registro sin republicar 36 h, comprobación antigua (el disparador no corre).
- Si el front manda el bloque `ops` (pedidos pendientes, emails sin enviar, estado del reconcile), el panel aplica además reglas de negocio con avisos solo en el cambio: ver [observabilidad.md](observabilidad.md) §3.
- No incluye todavía la salud «por empuje», uso y negocio ni cuotas: llegan con el umbral de 3 a 5 clientes.

## 5 · Copia del registro

```bash
cd apps/control-panel
REGISTRY_EXPORT_KEY=… npm run registry:export -- --out ./copias/registro-2026-10-09.json
# …y para restaurar, sobre una BD de control VACÍA recién migrada:
REGISTRY_EXPORT_KEY=… npm run registry:import -- --in ./copias/registro-2026-10-09.json
npm run operator:create …         # los operadores no van en la copia
npm run snapshots:refresh         # reconstruye el almacén replicado
```

AES-256-GCM. Al restaurar, el contador `snapshotSeq` de cada suscripción **salta 100 000** (por orden y auditoría: el anti-replay del front ya no depende del `seq` sino del `iat`, así que una restauración del panel —también un PITR de Neon— se recupera sola con el siguiente `snapshots:refresh`, sin hasta 6 h de clientes obsoletos). Incluye clientes, suscripciones, módulos, dominios, claves de licencia (solo hash) y auditoría; **no** operadores, sesiones ni TOTP, ni datos operativos. Las URLs de BD van selladas (`enc:v2`): para usarlas tras restaurar hace falta además `SECRETS_KEYS`. **Guarda el fichero, `REGISTRY_EXPORT_KEY` y `SECRETS_KEYS` en sitios distintos y fuera de la plataforma.** La restauración se niega si la BD no está vacía o si la cadena de hashes de la auditoría del fichero no verifica. El registro replicado (Upstash) se puede reconstruir entero desde la BD de control.

Programar la copia (semanal, como mínimo) y subirla a un almacenamiento externo es decisión tuya: requiere dar a un runner la URL de la BD de control y las claves.

## 6 · Proyectos de Vercel y orden de un release

Tres proyectos desde este mismo repositorio. La configuración se hace en Vercel (Settings), no en ficheros, para no cambiar el proyecto antiguo.

| | La Grailla actual (`off`) | `platform` | Panel |
|---|---|---|---|
| Root Directory | raíz | raíz | `apps/control-panel` (con «Include source files outside of the Root Directory») |
| Build Command | `npm run build` (migra la BD: sigue así hasta probar el runner) | `npm run build:platform` | `npm run build` |
| Node.js | el que tenga | **22.x** (`.nvmrc`) | 22.x (`engines`) |
| Región de las funciones | la que tenga | **fra1** (junto a Neon y Upstash, UE) | `fra1` (`vercel.json`) |
| Variables de producción | las de siempre | las del front en modo plataforma | las del panel |

**Variables solo en el entorno «Production» y marcadas «Sensitive»** (`SECRETS_KEYS`, `PLATFORM_*`, `LEGACY_NEXTAUTH_SECRET`, tokens de Upstash, `CONTROL_DATABASE_URL`, `SNAPSHOT_SIGNING_KEY`, `CRON_SECRET`…), nunca en «Preview» ni en «All Environments»: quien pueda subir una rama podría leerlas desde su propio código y abrir las BD de todos los clientes. Además, un despliegue de vista previa (`VERCEL_ENV=preview`) de `platform` o del panel responde 404 a todo, aunque heredase variables. Activa también **Deployment Protection** en las vistas previas.

**Una base de Upstash por entorno** (producción, pruebas). Los nombres de clave (`h:{host}`, `s:{tenantId}:{producto}`) no llevan entorno: se aíslan con la base, no con un prefijo.

**Tokens de Upstash:** el panel tiene el de **escritura** (`UPSTASH_REDIS_REST_TOKEN`); el proyecto `platform` solo el de **solo lectura** (`UPSTASH_REDIS_REST_READ_ONLY_TOKEN`, «Read-Only Token» en la consola de Upstash). El front no escribe nunca; con el de escritura, quien comprometiera el front podría borrar la revocación de un cliente o reponer snapshots antiguos. `npm run platform:preflight` falla si el front solo tiene el de escritura.

**Regla de `contractVersion`** (el contrato entre el panel y los fronts, `packages/contracts`): los cambios que **solo añaden** (campos opcionales, un motivo de rechazo nuevo) **no suben la versión**: los fronts ignoran lo que no conocen. Una subida real solo se hace para un cambio que rompe, y siempre en este orden: **primero se despliegan todos los fronts** (el proyecto antiguo y `platform`) con el código que entiende la versión nueva, y **después** el panel que la publica. Un front que no entiende la versión que publica el panel la trata como snapshot inválido y a las 6 h devuelve 503 a todos sus clientes.

**Un release que toca el esquema, mientras convivan el proyecto antiguo y `platform`**, siempre en este orden:
1. Subir una **rama y abrir un PR** (no empujar a `main`: lo desplegaría el proyecto antiguo y migraría la BD de producción con código que la CI no ha visto). Esperar la CI en verde.
2. Fusionar en una ventana sin eventos. El proyecto antiguo despliega y migra la BD de La Grailla en su build.
3. `npm run migrate:tenants` (desde una máquina de operación): aplica las migraciones a los demás clientes, **sincroniza el `schemaVersion` del registro y republica**. Sin este paso, `platform` pondría «en mantenimiento» (503) a todo cliente cuyo registro esté por detrás de `FRONT_MIN_SCHEMA`.
4. Recién entonces, **promocionar** el despliegue de `platform` (desactiva la promoción automática: Settings → Git → «Production Branch» manual, o Ignored Build Step) y comprobar `/health` del panel.

La CI vigila dos cosas de este orden: toda migración posterior a `FRONT_MIN_SCHEMA` debe decidir por escrito si el front la necesita (`-- front-min-schema: not-required <motivo>`, o se sube `FRONT_MIN_SCHEMA`), y el front en modo plataforma y el panel se compilan de verdad (`next build`) en cada PR.

## Revisión independiente (aplicada)

Un agente revisó M7 con mentalidad adversarial y verificó cada hallazgo; los reales se arreglaron con su test:

| Gravedad | Hallazgo | Arreglo |
|---|---|---|
| Alto | El runner no sincronizaba el registro si no había migraciones pendientes: un cliente con la BD al día y `schemaVersion` null quedaba en mantenimiento y «ejecuta el runner» no lo arreglaba | Sincroniza y republica también sin pendientes |
| Alto | Un cliente en mantenimiento por la puerta de esquema se veía «ok» desde fuera y solo «Atención» en el panel | `/api/health` público da 503 `maintenance`; el detalle trae `serving`; el panel lo marca «Falla» |
| Medio | `lock_timeout` residual tras un crash se volvía permanente; un fallo al restaurarlo tapaba el resultado | Un valor igual al nuestro se trata como residuo; el fallo al restaurar solo avisa |
| Medio | La contraseña inicial se perdía si un paso posterior lanzaba | Callback inmediato `onCredentials` y paso `finish` fallido en vez de excepción |
| Medio | Repetir un alta con otra URL de BD usaba la antigua en silencio | `database_mismatch` |
| Medio | El disparador pasaba del presupuesto con llamadas lentas y el backoff retrasaba hasta 1 h un cobro | Presupuesto descuenta el tiempo de la llamada; tope de 15 min para reconcile |
| Medio | Restaurar el registro hacía retroceder `snapshotSeq` (los fronts lo rechazan como repetición) | Salto de 100 000 al importar |
| Bajo | El marcador `allow-destructive` saltaba el linter del runner; `BEGIN/COMMIT`/`CONCURRENTLY` pasaban | La bandera es obligatoria aunque haya marcador; reglas duras sin escape |
| Bajo | `migrate:tenants` salía con 0 si no se podía republicar; `prisma` heredaba todo el entorno del panel; `http://` admitido en producción; `err.message` sin filtrar URLs; 500 «Cron no configurado» sin autenticar | Salida con error; lista blanca de entorno; https obligatorio; filtrado; 401 |

**No se arregló (decisión):** límite de tasa del `/api/health` público (WAF), y que sellar `reconcileCheckedAt` antes de verificar manda al final de la cola a un pedido aún sin pagar (con miles de carritos pendientes, un pago SumUp puede tardar varias pasadas; sigue siendo mejor que el orden anterior). Confirmado como bien resuelto: aislamiento del secreto de cron, no filtración en `/api/health`, no seguir redirecciones, comparaciones en tiempo constante, identificadores SQL, URLs fuera de argv/auditoría, cifrado de la copia y ausencia de cambios en modo normal.

## Verificado

- 210 tests del panel (nuevos: runner, alta, crons, salud, copia) y 927 del front, `tsc` y lint limpios, `next build` del panel y del front en modo normal.
- Runner contra Postgres reales: migración de cero con las 32 migraciones del repo, parada ante fallo, canarios, linter, bloqueo real con `lock_timeout` + recuperación, ejecución concurrente, ejecución abandonada.
- **De punta a punta en local**: registro de desarrollo + front en modo plataforma (`c.localhost`) + `tenant:provision` con BD local nueva → web neutra del cliente, aviso legal con el texto sembrado, login del administrador con la contraseña generada y `/api/health` público mínimo; el disparador real (`/api/cron/dispatch`) ejecutó las tres tareas contra ese cliente con su secreto derivado.

## No verificado / límites

El ensayo de todo esto en infraestructura real (sondas ejecutables, criterios de pasa/falla y registro de resultados) está en [`m8-ensayo.md`](./m8-ensayo.md).

- Nada de esto se ha ejecutado contra **Vercel, Neon ni GitHub Actions**: el parámetro de arranque `options=-c lock_timeout=…` funciona contra Postgres local y con el motor de Prisma, pero no se ha probado contra el endpoint **directo** de Neon (los pooled no admiten parámetros de arranque; el runner usa el directo). Prueba: ejecutar el runner sobre una rama desechable de Neon con una migración que haga `SHOW lock_timeout`; si Neon lo rechaza, `MIGRATION_LOCK_TIMEOUT_MODE=database`; Vercel Cron no se ha ejecutado (primera ejecución real: lanza `GET /api/cron/dispatch?job=tenants` con `Authorization: Bearer $CRON_SECRET` y comprueba `ran > 0`); la creación de proyectos de Neon sigue siendo manual (`--database-existing`).
- Solo en el plan B (`MIGRATION_LOCK_TIMEOUT_MODE=database`): un runner que muere entre `ALTER DATABASE SET lock_timeout` y su `RESET` deja el `lock_timeout` de 3 s en esa BD; se comprueba con `SELECT setconfig FROM pg_db_role_setting`. Con el modo por defecto no hay nada que limpiar.
- El runner ya no rechaza como «transacción explícita» un bloque `DO $$ BEGIN … END $$` (el filtro ignora lo que va entre `$$…$$`).
- La **saga reanudable** con estado propio (`ProvisioningRun`), el borrado de tenant, el reconciliador de deriva y la salud por push siguen en el umbral de 3 a 5 clientes.
- No se ha hecho la matriz de CI «front N contra esquema N-1/N+1» ni el «dry-run en rama de Neon»: el `--dry-run` actual solo lista y pasa el linter.
- `next build` en modo plataforma y el aviso de onboarding del admin no se han visto renderizados con datos reales más allá del flujo local.
