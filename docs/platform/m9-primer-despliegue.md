# Primer despliegue a producción (paso a paso)

Plan: infraestructura de producción **vacía con un cliente demo** → sondas de `m8-ensayo.md` → ensayo del runner sobre una **rama** de la BD real de La Grailla → y solo entonces el corte de La Grailla (`m5-cutover.md`). Hasta ese último paso no se toca nada de La Grailla: ni su BD, ni su dominio, ni su proyecto de Vercel.

Reglas que valen en todo el documento:
- **Ningún valor secreto va por chat.** Ni URLs de BD, ni tokens, ni el contenido de los ficheros de claves. Me pasas solo lo que aquí se marca como «Me devuelves».
- **No se empuja a `main`.** Los dos proyectos nuevos siguen una rama `plataforma`. `main` sigue siendo la del proyecto antiguo.
- Los nombres de menú de Vercel, Neon y Upstash cambian de vez en cuando: si uno no coincide, busca el equivalente.

## 0 · Claves de producción (en tu Mac, 2 minutos)

```bash
    cd apps/control-panel
    npm run keys:prod -- generate
```

Crea `~/grailla-produccion/` (fuera del repo) con tres ficheros de permisos 0600 y **no muestra ningún valor**:

| Fichero | Va a | Contiene |
|---|---|---|
| `panel.env` | proyecto `grailla-panel` de Vercel | claves de secretos y de firma, `CRON_SECRET`, y los `__RELLENA__` de Neon y Upstash |
| `platform.env` | proyecto `grailla-platform` de Vercel | las mismas claves compartidas, la clave pública, y los `__RELLENA__` de Upstash (token de solo lectura) |
| `ops.env` | **no va a Vercel** | `REGISTRY_EXPORT_KEY`, para las copias cifradas del registro |

**Guarda los tres ya en tu gestor de contraseñas.** Las variables marcadas «Sensitive» en Vercel no se pueden volver a leer, y perder `SECRETS_KEYS` es perder las URLs de BD de todos los clientes. El script no sobrescribe nunca ficheros existentes ni acepta una carpeta dentro del repo.

## A · Vercel (primera pasada: proyectos y dominios, sin variables)

Todo dentro del **equipo Pro**, no en una cuenta personal (los crons de cada 5 minutos solo existen en Pro).

1. **Mira el proyecto antiguo de La Grailla** (solo mirar): Settings → Git. ¿Está conectado al repo `pms96/la-grailla` y a la rama `main`? Es la respuesta que decide cómo de cuidadosos hay que ser con `main`. *Me devuelves: sí/no y la rama.*
2. **Dime «sube la rama»** y yo ejecuto `git push origin HEAD:plataforma` (la CI se lanza por primera vez ahí). No toca `main`. Hace falta que exista antes de configurar los proyectos.
3. **Proyecto del panel**: Add New → Project → importa `pms96/la-grailla`.
   - Nombre: `grailla-panel`.
   - Root Directory: `apps/control-panel` y **marca «Include source files outside of the Root Directory»**.
   - Framework Next.js, Build Command por defecto (`npm run build`).
   - **No añadas variables todavía** y despliega: el primer despliegue (de `main`, que en GitHub aún no tiene el panel) **fallará, es lo esperado**.
   - Luego, Settings → General: Node.js Version **22.x**. Settings → Git: **Production Branch = `plataforma`**.
4. **Proyecto del front**: otra vez Add New → Project con el mismo repo.
   - Nombre: `grailla-platform`.
   - Root Directory: la raíz del repo.
   - Build Command: override → `npm run build:platform`.
   - Primer despliegue fallido, también esperado.
   - Después: Node.js **22.x**, Settings → Functions → Function Region **Frankfurt (fra1)**, Production Branch = `plataforma`.
5. **Dominios.** Necesitas un dominio tuyo que **no** sea el de La Grailla. En el proyecto del panel añade `panel.tudominio.es`; en `grailla-platform` añade `demo.tudominio.es` y `sin-alta.tudominio.es`. Vercel te muestra el registro DNS de cada uno (normalmente un CNAME): créalos en tu proveedor de DNS. El segundo **no** se dará de alta como cliente: sirve para comprobar que da 404. *Me devuelves: los tres nombres de dominio.*
6. **Seguridad.** En los dos proyectos: Settings → Deployment Protection → activa la protección de las vistas previas. (Las vistas previas ya responden 404 por código, esto es la segunda capa.)
7. **`vercel login`** en la terminal de tu Mac (para que yo pueda ver los despliegues y los logs de los crons con tu permiso).

## B · Neon (cuenta tuya de proveedor)

En ambos proyectos: Postgres **16**, región **AWS Europe (Frankfurt)**, y deja desactivadas las opciones adicionales (Neon Auth, etc.).

1. **Proyecto `grailla-control`**: la BD de control del panel. Te recomiendo un plan de pago de entrada para este (lo consulta el cron cada 5 min, no se suspende, y es lo que restaura todo); es decisión tuya.
2. **Proyecto `grailla-demo`**: la BD del cliente demo, en plan gratuito.
3. En cada proyecto: **Connect** (o Connection details) → rama `main`, base de datos `neondb`, rol `neondb_owner` → copia **dos** cadenas:
   - **Pooled** (con el interruptor «Connection pooling» activo; el host lleva `-pooler`). Añade `&pgbouncer=true` al final.
   - **Directa** (interruptor desactivado; el host no lleva `-pooler`).
4. **Pega las URLs directamente en los ficheros, no en el chat**:
   - `grailla-control` → en `~/grailla-produccion/panel.env`, sustituyendo `CONTROL_DATABASE_URL` (pooled) y `CONTROL_DIRECT_URL` (directa).
   - `grailla-demo` → de momento guárdalas en tu gestor de contraseñas, con un nombre claro. Las usaremos al dar de alta el cliente demo.
5. **Más adelante**, en el proyecto de La Grailla (no ahora): una **rama** desechable `ensayo-runner` desde el estado actual (Branches → Create branch). Es una copia de datos reales: se trata como producción y se borra al terminar. También: anota qué plan tiene esa BD y cuánta **ventana de restauración** (Settings → Restore / history retention). *Me devuelves: el plan y la ventana.*

## C · Upstash

1. Create Database → nombre `grailla-registro`, región primaria **EU (Frankfurt)**, tipo regional, **TLS activado** y **eviction desactivado**.
2. En la sección REST API: copia la **URL** y el **token de escritura**. Activa el interruptor «Read-Only Token» y copia también el de **solo lectura**.
3. Pega en los ficheros, no en el chat:
   - `panel.env` → `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN` (escritura).
   - `platform.env` → `UPSTASH_REDIS_REST_URL` (la misma) y `UPSTASH_REDIS_REST_READ_ONLY_TOKEN` (solo lectura). **El front nunca lleva el de escritura.**

## D · Variables y primer despliegue real (Vercel, segunda pasada)

1. Comprueba los ficheros:
   ```bash
   cd apps/control-panel
   npm run keys:prod -- check
   ```
   Debe terminar en «Todo listo». Si algo falla, te dice qué (nombres, nunca valores).
2. En `grailla-panel`: Settings → Environment Variables → **Import .env** y pega el contenido de `panel.env`. **Solo el entorno Production** (quita Preview y Development) y marca cada variable como **Sensitive**.
3. Lo mismo en `grailla-platform` con `platform.env`.
4. Redespliega los dos (Deployments → Redeploy de `plataforma`, o un push a la rama). Esta vez deben terminar en verde.
5. En `grailla-panel` → Settings → Cron Jobs deben aparecer las dos tareas de `vercel.json` (`tenants` cada 5 minutos y `snapshots-refresh` a diario).

## E · Dar de alta y poner en marcha clientes desde el panel (sin comandos)

Todo lo de esta sección se hace en el panel; los comandos `tenant:provision`, `migrate:tenants` y `tenant:go-live` siguen existiendo y hacen lo mismo.

**Cliente nuevo** (`/tenants/new`, solo superadmin):
1. En Neon, crea el proyecto del cliente (Postgres 16, Frankfurt) y copia sus dos URLs (pooled y directa).
2. En el panel, «Alta completa»: nombre, dominio, módulos, las dos URLs, email de administración, nombre y correo del administrador de su web y los tres textos legales. «Dar de alta».
3. El panel registra, migra la BD, siembra los datos, crea el administrador, verifica el dominio y publica. Cada paso sale con ✓ o ✗. Si algo se corta, repites con los mismos datos y continúa donde se quedó.
4. **Acceso del administrador de su web.** Con la casilla «Invitar al administrador» (marcada por defecto) **no hay contraseña temporal**: el administrador recibe un enlace de un solo uso, que caduca a las 72 horas, para fijar la suya. La invitación solo puede salir cuando el dominio ya está verificado: si todavía no lo está, el alta lo dice y se envía después desde la ficha (apartado «Invitar al administrador de su web»). Sin la casilla, el panel crea al administrador con una **contraseña temporal que se muestra una sola vez**: guárdala y pásasela al cliente por un canal seguro.
5. El panel dice qué registro DNS crear (el TXT de verificación y el CNAME o A hacia Vercel). Cuando exista, entra en la ficha y pulsa «Salir a producción».

**Cliente ya registrado** (ficha, tarjeta «Puesta en marcha»): la lista de pasos dice cuál toca. Botones: **Migrar BD**, **Datos iniciales** (email de avisos, textos legales y administrador, para quien se registró sin ellos), **Salir a producción**, **Comprobar salud**. En cada dominio, **Añadir a Vercel**.

**Dominios en Vercel desde el panel (opcional).** Sin esto, el panel enseña el registro DNS y tú añades el dominio a mano en el proyecto `grailla-platform`. Para que lo haga el panel, añade estas variables al proyecto **`grailla-panel`** (solo Production, Sensitive) y redespliega:

| Variable | Qué es |
|---|---|
| `VERCEL_API_TOKEN` | Un token de Vercel creado **solo para esto** (Account Settings → Tokens), con caducidad. Los tokens de Vercel son del equipo, no de un proyecto: con él se pueden tocar todos sus proyectos. Guárdalo en el gestor de contraseñas. |
| `VERCEL_PLATFORM_PROJECT_ID` | El id (`prj_…`, en Settings → General) o el nombre del proyecto `grailla-platform`. |
| `VERCEL_TEAM_ID` | El id del equipo (`team_…`, en Settings → General del equipo). No hace falta en una cuenta personal. |

Los dominios `*.vercel.app` no necesitan nada de esto.

**Invitaciones por correo (opcional).** La ficha del cliente tiene el botón «Enviar invitación» (superadmin; necesita la BD migrada, un administrador creado y el dominio verificado). El panel guarda en la BD del cliente un token de un solo uso (solo su hash) y le manda al administrador un enlace a la web del propio cliente (`/auth/establecer-contrasena?token=…`) donde fija su contraseña (mínimo 10 caracteres). Volver a invitar anula la invitación anterior. La contraseña no pasa nunca por el panel ni por el correo. No hace falta ninguna migración de BD.

Sin correo configurado en el panel, el botón te enseña el enlace **una sola vez** para que se lo pases tú. Para que lo envíe el panel, añade estas variables al proyecto **`panel-control`** (solo Production, Sensitive) y redespliega:

| Variable | Qué es |
|---|---|
| `PANEL_SMTP_HOST` | Servidor SMTP del proveedor de correo que elijas. |
| `PANEL_SMTP_USER` | Usuario SMTP. |
| `PANEL_SMTP_PASSWORD` | Contraseña SMTP (o clave de API SMTP). |
| `PANEL_SMTP_FROM_EMAIL` | Remitente de las invitaciones, p. ej. `no-reply@tudominio.es`. Mejor con SPF y DKIM configurados para ese dominio. |
| `PANEL_SMTP_PORT` | Opcional, 587 por defecto (465 activa TLS directo). |
| `PANEL_SMTP_SECURE` | Opcional, `true` para TLS directo. |
| `PANEL_SMTP_FROM_NAME` | Opcional, «La Grailla» por defecto. |

**DPA:** el proveedor de correo que configures aquí es un **subencargado más** (ve el correo del administrador del cliente y el enlace de invitación): añádelo a la lista del DPA antes de usarlo con clientes reales. Es una cuenta tuya de proveedor, no la del cliente. El correo no lleva datos del cliente más allá de su nombre comercial.

**Qué no hace el panel:** crear el proyecto de Neon del cliente, ni crear los registros DNS en tu proveedor (los muestra), ni restablecer contraseñas olvidadas (la invitación sirve también para eso: vuelve a pulsar «Enviar invitación»).

## Qué hago yo a partir de ahí (necesito tu «adelante» al terminar la sección D)

1. Migro la BD de control de producción y creo tu usuario operador del panel (la contraseña inicial te la doy por fichero, no por chat).
2. Doy de alta el cliente demo con la BD `grailla-demo` y el dominio `demo.tudominio.es`.
3. Paso las sondas de `m8-ensayo.md`: registro (P1), Neon (P2), dominios y caché (P4, con los tres dominios) y crons (P5). Te cuento qué pasa y qué no.
4. Con la rama `ensayo-runner`, ensayo el runner de migraciones (P3).
5. Solo si todo está en verde: preparamos el corte de La Grailla, con ventana sin eventos (`m5-cutover.md`).

## Antes del corte (no antes)

- La Grailla **no se mueve** hasta que haya: la ventana de restauración de su BD comprobada, un monitor externo sobre `/api/health`, una ventana sin eventos ni ventas, y la asignación automática de dominios de producción **desactivada** en `grailla-platform` (Settings → Domains/Environments → Production), para que un push no pueda mover tráfico real.
- Variables del corte, solo entonces: `LEGACY_TENANT_ID`, `LEGACY_NEXTAUTH_SECRET` (el valor actual de `NEXTAUTH_SECRET` de La Grailla, **idéntico**) y `BLOB_READ_WRITE_TOKEN`.
