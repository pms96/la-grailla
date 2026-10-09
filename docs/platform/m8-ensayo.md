# Fase 1 · Ensayo en infraestructura real

Todo lo que el código no puede demostrar solo: cómo se comportan Neon, Upstash y Vercel de verdad. Se hace en un **entorno de pruebas separado** (proyectos, bases y dominios propios) y **antes** de dar de alta al segundo cliente real y de mover el dominio de La Grailla (`m5-cutover.md`). Nada de este ensayo toca la BD, el dominio ni Stripe de La Grailla.

Cada comprobación tiene su sonda (`npm run infra:probe`, desde `apps/control-panel`): solo lee, no imprime URLs ni tokens y sale con código 1 si algo falla. Sus tests y el código están en `lib/ops/infra-probe.ts`. Los números de latencia que dan desde un portátil son solo un orden de magnitud: los que cuentan son los de los logs de Vercel.

Si el entorno de pruebas es el propio entorno de producción con un cliente demo (la opción elegida para el primer despliegue), los pasos de alta de proyectos, bases y variables están en [`m9-primer-despliegue.md`](./m9-primer-despliegue.md).

## 0 · Qué hace falta (lo pones tú; nada de esto va por chat)

Los valores van en variables de entorno de tu shell o en un fichero `.env.ensayo` fuera de git; las sondas reciben el **nombre** de la variable, no el valor.

| Recurso | Para qué | Notas |
|---|---|---|
| **Upstash «pruebas»** (una base nueva, región UE) + su *Read-Only Token* | P1 | Una base por entorno: no reutilices la de producción cuando exista |
| **Neon: BD de control de pruebas** y **dos BDs de cliente** (A y B), cada una con URL *pooled* y *directa* | P2, P3, P6 | Lo fiel al modelo real es un proyecto (o cuenta) por cliente. Para una **rama desechable** de una BD con datos: «Branch» en la consola de Neon |
| **Dos proyectos de Vercel**: `platform-pruebas` y `panel-pruebas`, región `fra1`, Node 22 | P4, P5 | Ver «Despliegue del entorno de pruebas» |
| **Dos subdominios tuyos** apuntados a `platform-pruebas` (p. ej. `a.pruebas.tudominio.es`, `b.pruebas.tudominio.es`) y uno **sin dar de alta** (`z.pruebas…`) | P4 | El DNS de un dominio tuyo; los clientes de prueba no necesitan dominios reales |
| `vercel login` en esta máquina (hoy el token no es válido) | despliegue | O despliega desde el panel de Vercel |

### Despliegue del entorno de pruebas

Las vistas previas (`VERCEL_ENV=preview`) responden 404 **a propósito** (`m7-operacion.md`, apartado 6), así que el ensayo se despliega como **Production** de proyectos de pruebas separados: o `vercel deploy --prod` desde el CLI, o un proyecto cuya *Production Branch* sea una rama `ensayo`. **Subir esa rama a un remoto es decisión tuya**; no hace falta para el CLI. Las variables (`m7-operacion.md`, apartado 6 y `.env.example` de la raíz y del panel) van solo en *Production* y como *Sensitive*; el front lleva solo el token de **solo lectura**.

Datos del ensayo: crea con `npm run tenant:provision` (apartado 1 de `m7-operacion.md`, con `--database-existing`) los clientes **A** y **B** con módulos distintos y **marcas distintas** (el título de la portada es lo que las sondas comparan), y el dominio con `--domain manual`.

## 1 · Las comprobaciones

Orden recomendado; cada una dice qué prueba y cuándo se da por buena.

### P1 · Registro (Upstash)

```bash
cd apps/control-panel
npm run infra:probe -- registry --url-env UPSTASH_URL --write-token-env UPSTASH_RW --read-token-env UPSTASH_RO
```

Bien si: escribe con el token de escritura, **el de solo lectura lee y no puede escribir ni borrar**, y no hay claves ajenas (una base por entorno). Después, `npm run platform:preflight` del front debe terminar en «Todo listo.».
Aparte, mira en la consola de Upstash el **consumo** tras 24 h con los dos clientes y haz la cuenta: el front lee con caché de 15–30 s por instancia y host, de modo que los comandos al mes dependen de cuántas instancias haya despiertas. Si el plan gratuito se queda corto, es el cliente quien sube de plan (decisión ya tomada).

### P2 · Neon: `lock_timeout`, locks y arranque en frío

```bash
NEON_A_DIRECT='postgresql://…' NEON_A_POOLED='postgresql://…-pooler…?pgbouncer=true' \
npm run infra:probe -- neon --direct-env NEON_A_DIRECT --pooled-env NEON_A_POOLED
```

Bien si:
- **`El endpoint directo respeta «options=-c lock_timeout»`**. Si falla, el plan B es `MIGRATION_LOCK_TIMEOUT_MODE=database` (`ALTER DATABASE … SET`, que sí afecta a las conexiones normales mientras dura la migración). Decide con el resultado, no antes.
- **Las conexiones normales no se ven afectadas** y **la espera de bloqueo se corta a ~1 s**.
- **Por la URL pooled, el lock de asesoramiento serializa.** Si falla, el front no puede usar ese modo de pool: la venta de la última entrada podría sobrevenderse. Es el punto más importante de todo el ensayo.

Arranque en frío y consumo del plan gratuito (tarda ~6 min, deja la BD sin tráfico):

```bash
npm run infra:probe -- neon --direct-env NEON_A_DIRECT --cold-start --idle-seconds 330
```

Informa de cuánto tarda la primera consulta tras la suspensión. **Con el cron de cada 5 min la BD no llega a suspenderse**: comprueba en la consola de Neon las horas de cómputo tras un día con los dos clientes y compáralas con el límite vigente del plan gratuito (verifícalo en su web: cambia). Si no cabe, las opciones son espaciar los crons de salud de ese cliente o que el cliente suba de plan.

### P3 · El runner sobre una rama desechable

1. En Neon, crea una **rama** de la BD del cliente A (copia con datos). Usa su URL directa como `--direct-env`.
2. Registra la rama como cliente de prueba en el panel de pruebas y ejecuta `npm run migrate:tenants -- --only <subscriptionId> --dry-run` (solo lista y pasa el linter) y después sin `--dry-run`. `--only` evita tocar a los demás clientes del registro.
3. Opcional pero recomendado: en un *worktree* aparte (nunca en el repo) añade una migración temporal que verifique que el **motor de migraciones** (no solo una conexión normal) ve el `lock_timeout`:
   ```sql
   DO $$ BEGIN
     IF current_setting('lock_timeout') <> '3s' THEN RAISE EXCEPTION 'lock_timeout no llegó al motor: %', current_setting('lock_timeout'); END IF;
   END $$;
   ```
   (con `-- front-min-schema: not-required ensayo`). Bien si se aplica; si el motor no lo ve, plan B de P2. Descarta el *worktree*.
4. Bien si: migra, el `schemaVersion` del registro se sincroniza y republica, y `/api/health` del cliente dice el esquema esperado.

### P4 · Dominios y caché de Vercel (aislamiento por Host)

```bash
npm run infra:probe -- hosts \
  --origin https://a.pruebas.tudominio.es --origin https://b.pruebas.tudominio.es \
  --region fra1 --unknown-origin https://z.pruebas.tudominio.es
```

Hace dos vueltas **intercaladas** (A, B, A, B) sobre portada, `/api/health`, `robots.txt` y `sitemap.xml`. Bien si: cada dominio muestra **su** marca y el título es estable entre peticiones (una caché que mezclara Hosts serviría a A la página de B en la segunda vuelta); `/api/health` público solo devuelve `status`; `robots` y `sitemap` no nombran al otro cliente; las funciones corren en `fra1`; el dominio no dado de alta responde 404. También: la URL de una **vista previa** del mismo proyecto responde 404 (`--preview-origin`).

Con la sonda en verde, comprueba a mano lo que ella no ve:
- Las respuestas de `/`, `/eventos`, `/tienda`, `/sponsors` y `/legal/*` llevan `Vercel-CDN-Cache-Control: max-age=60` y se ven `x-vercel-cache: HIT` en la segunda petición; `/admin` y `/api/*` van con `private, no-store` y nunca en caché.
- **Purga por etiqueta**: cambia el nombre de la web del cliente A desde su panel y ejecuta `vercel cache invalidate --tag t:<tenantId>:public` (la etiqueta es la que el middleware pone en cada página pública, `lib/tenant/middleware.ts`). Bien si la portada de A cambia y la de B sigue en `HIT`. Si el CLI no admite la etiqueta o no purga solo a A, hay que depender del `max-age=60` y retirar la promesa de purga selectiva de la documentación.

### P5 · Vercel Cron y el disparador

Despliega el panel de pruebas con `vercel.json` (los dos crons) y `CRON_SECRET`. Primero a mano:

```bash
npm run infra:probe -- cron --panel-url https://panel-pruebas.tudominio.es --secret-env CRON_SECRET
```

Bien si: sin secreto responde 401; con él, `job=tenants` responde 200 con `ran > 0` (hay clientes con tareas vencidas) y `job=snapshots-refresh` republica todos. Después **espera a la primera ejecución real de Vercel Cron** (Settings → Cron Jobs → logs): debe aparecer `[cron-dispatch] due=… ran=… failed=0` y el estado 200. Provoca un fallo (pon una URL de BD errónea en un cliente de prueba) y comprueba que la ejecución queda como **fallida**: Vercel no avisa por sí solo, esa alerta es de la Fase 2.

### P6 · Aislamiento de extremo a extremo con datos reales de BD

Con A y B desplegados: inicia sesión como administrador de A y copia la cookie en una petición a B (debe rechazarse: secretos de sesión distintos); crea un pedido de prueba en A y comprueba que no aparece en el panel de B; abre el `/api/health` de A con el secreto de cron de B (debe dar solo `status`). Mismo ejercicio que los tests con dos BDs, pero con la infraestructura de verdad. Si hay Stripe en modo prueba de A, un pago de prueba debe confirmarse por el webhook con el secreto de A y rechazarse con el de B.

### P7 · Copia del registro restaurada de verdad

Ya está ensayado en local (export → restore en BD vacía → mismos conteos → `snapshots:refresh` reconstruye el registro; se niega a restaurar sobre una BD no vacía). Repítelo contra Neon: exporta la BD de control de pruebas, restaura en una **rama nueva vacía** migrada, y `snapshots:refresh` contra la base de Upstash de pruebas. Bien si los dos clientes vuelven a servirse. Anota cuánto se tarda: es el tiempo real de recuperación del panel.

## 2 · Criterio de salida

La Fase 1 está cerrada cuando **P1–P5 pasan** y P6–P7 están hechos y anotados. Lo que no pasa **no se arregla en caliente**: se anota en esta página con la fecha y se decide (plan B, cambio de código, o aceptar y documentar) antes de la Fase 2. Resultados sin ejecutar quedan abajo; hoy:

| Prueba | Estado | Fecha | Resultado |
|---|---|---|---|
| P1 Registro | sin ejecutar (la sonda está lista y probada contra un registro local con token de solo lectura) | | |
| P2 Neon | sin ejecutar (la sonda pasa contra Postgres 16 local) | | |
| P3 Runner en rama | sin ejecutar | | |
| P4 Dominios y caché | sin ejecutar (la sonda detecta una caché que mezcla Hosts en sus tests) | | |
| P5 Vercel Cron | sin ejecutar | | |
| P6 Aislamiento real | sin ejecutar | | |
| P7 Restauración en Neon | local hecha (3 clientes, 13 módulos, 49 entradas de auditoría idénticos; registro reconstruido con 3 `h:` y 3 `s:`); Neon sin ejecutar | 2026-10-09 | |

## 3 · Limpieza y coste

Borra los proyectos de Vercel, las bases de Upstash y las ramas de Neon de pruebas al terminar, o déjalos como el entorno de pruebas permanente (recomendado: sirve para ensayar cada release que toque el esquema antes de tocar producción). El ensayo no deja nada en la BD de ningún cliente real; la única escritura de las sondas es una clave `__probe__:*` con caducidad de 2 minutos en la base de Upstash de pruebas, que borran ellas mismas.
