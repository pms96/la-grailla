# Checklist de lanzamiento (La Grailla y clientes de la plataforma)

Una página para el propietario. El detalle de cada punto está en `runbook-despliegue.md` (las referencias «§n» son de ese documento) y el porqué de lo aceptado en `cierre-revision-integral.md`.
Ramas y proyectos: **`main` es la única rama**; `la-grailla-platform` (front) y `panel-control` (panel) despliegan de `main` en Vercel.

## 0. Ya está hecho (no hay que repetirlo)
- [x] Una sola rama, `main`; CI de GitHub en verde; los workflows programados y manuales ya aparecen en Actions.
- [x] BD de control del panel migrada (workflow «Migrar la BD de control»); el aviso rojo del panel ya no sale.
- [x] Decisiones del propietario: dominios, enlaces de pedido, anulación de ventas de puerta, rol contable (runbook §20-§22).

## 1. Cada vez que despliegues (en este orden)
1. [ ] **Actions en verde** para el último commit de `main` (pestaña Actions → CI). Un commit no está «verde» hasta que lo está el CI.
2. [ ] **Si el release trae una migración del panel:** Actions → «Migrar la BD de control» → Run workflow → modo **estado** y, si dice que falta, otra vez con modo **aplicar** (§18). *Antes* de desplegar el panel.
3. [ ] **Migrar la BD de cada cliente**, cliente a cliente y fuera de una venta en marcha: desde la ficha del cliente en el panel (migraciones) o, en `apps/control-panel`, `npm run migrate:tenants` (§1). El runner se niega a migrar si hay una venta en marcha o no puede comprobarlo; `--force-sales-window` solo si es imprescindible.
4. [ ] **Desplegar el front** (push a `main`). Un cliente cuya BD aún no está migrada ve «en mantenimiento» solo él, no el resto.
5. [ ] **Desplegar el panel** (no depende del orden con el front).

**Nunca:** volver el front a una versión anterior una vez migrada la BD de un cliente (se corrige hacia delante, §2), ni restaurar una BD a un punto anterior sin parar antes las ventas.

## 2. Al dar de alta un cliente o antes de abrir ventas (por cliente)
- [ ] **Temporadas en `CERRADA`:** listarlas y reabrir (solo el propietario, con motivo) las que sigan en uso; una cerrada da 423 al tocar gastos, ingresos o al mover cosas a ella (§3).
- [ ] **`jornada_corte_hora` = 6** si el cliente vende de madrugada (la noche de negocio acaba a esa hora).
- [ ] **`BLOB_PUBLIC_HOST`** del proyecto de plataforma: el host exacto del almacén de Blob, `<id>.public.blob.vercel-storage.com` (obligatoria en la plataforma).
- [ ] **Eventos creados antes del arreglo de zona horaria:** `DATABASE_URL=<BD del cliente> npx tsx scripts/listar-eventos-fecha-a-revisar.ts --antes-de=AAAA-MM-DD`, y comprobar «se ve ahora» contra la hora que el organizador sabe que es (§3).
- [ ] **Añadir la URL del cliente a `SMOKE_URLS`** (GitHub: Settings → Secrets and variables → Actions → Variables; varias URLs separadas por comas). Sin ella, el smoke tras desplegar no comprueba ese cliente.
- [ ] **Comprobar la plataforma:** `npm run platform:preflight` con las variables del proyecto de plataforma. Los ⚠ de `PLATFORM_ALERT_URL` y `SENTRY_DSN` no bloquean.

## 3. Justo después de desplegar
- [ ] **Smoke tras desplegar** en verde (Actions): lo lanza solo Vercel al terminar un despliegue de producción.
- [ ] **Descargar un pase de Apple Wallet** de una entrada de prueba: es lo único que los tests no pueden verificar de verdad (§13).
- [ ] **Entrar en el panel:** login con MFA → abrir un cliente → Auditoría → Salir.
- [ ] **Salud del panel:** un cliente nuevo sin marca de BD sale degradado con el motivo; revisar que todos los demás estén en verde.
- [ ] **Salud → Alertas → «Enviar alerta de prueba»:** debe llegarte al instante (móvil, chat o correo). Hazlo antes de fiarte de las alertas.

## 4. Variables y ajustes recomendados (los tuyos pendientes)
Opcionales, pero sin ellos nadie te avisa si algo se para. Las del panel van en el proyecto `panel-control` de Vercel (solo Production, tipo Sensitive) y hay que redesplegar.

| Variable | Dónde | Para qué |
|---|---|---|
| `HEARTBEAT_URL` | Panel (Vercel) | Latido contra la caída del propio panel. Crea una comprobación en **healthchecks.io** (gratis): periodo 10 min, margen 10 min, tu móvil o correo como destino, y pon su URL de «ping». |
| `HEARTBEAT_SNAPSHOTS_URL` | Panel (Vercel) | El mismo latido para el refresco diario de registros (04:17 UTC): otra comprobación de healthchecks.io, periodo 24 h y margen 2 h. |
| `ALERT_WEBHOOK_URL` y/o `ALERT_EMAIL_TO` | Panel (Vercel) | A dónde llegan las alertas. ntfy (gratis): instala la app, suscríbete a un tema largo y secreto (`grailla-` + `openssl rand -hex 12`) y pon `https://ntfy.sh/grailla-…`. La URL es un secreto. Para el correo hace falta el SMTP del panel (`PANEL_SMTP_*`). |
| `PLATFORM_ALERT_URL` | Front (proyecto de plataforma) | Avisa al operador de un cobro o reembolso de un pedido que no existe en la BD del cliente (un webhook apuntado al cliente equivocado). Debe ser una URL `https` (por ejemplo, un tema de ntfy). |
| `SENTRY_DSN` | Front (proyecto de plataforma) | Errores de servidor de cobros y webhooks en Sentry. Solo lo usa el front: el panel no tiene Sentry. |
| `SMOKE_URLS` | GitHub (variable de repositorio) | URLs que comprueba el smoke tras desplegar; una por cliente. |
| `DIRECT_URL` | Proyecto antiguo | Solo si aún despliegas el proyecto antiguo `la-grailla`; ya está desconectado del repo, así que puedes ignorarla. |
| Monitor externo | UptimeRobot o Better Stack (gratis) | Sobre `https://www.lagrailla.es/api/health` y la dirección de cada cliente: te avisa aunque el panel y Vercel Cron estén caídos. Cinco minutos. |

## 5. Si algo sale mal
- **Cortar la web de un cliente ya:** panel → ficha del cliente → **Emergencia** (en segundos, sin publicar; no toca webhooks de pago ni crons).
- **Marcha atrás del front:** solo con el módulo Contabilidad apagado en ese cliente mientras dure (§2).
- **Venta de puerta equivocada:** Administración → Ventas → «Anular venta de puerta» (solo el propietario, con motivo; la caja y el aforo se corrigen; el dinero se devuelve en caja) (§22).
- **Un comprador no puede abrir su entrada:** los enlaces caducan 30 días después del evento; un administrador abre el pedido y descarga el PDF (§21).
- **La BD de control va por detrás del panel:** aviso rojo en todas las pantallas del panel y latido de fallo; workflow «Migrar la BD de control» (§18).

## 6. Después del lanzamiento, cuando toque
- **Dependabot** abre un PR al mes con acciones de GitHub nuevas: mirar que el CI salga en verde antes de fusionarlo.
- **Purga de `ProcessedWebhookEvent`** si pasa de ~1 millón de filas (§8).
- **Stock fantasma (H-039):** no añadir tallas o colores a un producto con pedidos pendientes (§8).
- **Saltos mayores de dependencias:** Next 16, Sentry y zod 4 (§13): cada uno en su lote, con el CI en verde.
- **Mirar Actions tras cada push** (§19).

## 7. En espera de terceros (respuesta en ~1 mes)
- **Gestoría:** H-133 (IVA y margen; decide también H-254, reembolsos en temporada cerrada) y H-135 (justificantes con el emisor).
- **Abogado:** H-142 (prueba de edad y de menores), H-144 (textos por defecto que afirman lo que el código no sabe), H-028 y H-179 (retención y anonimización) y H-251 (el banner de cookies promete analítica que la política dice que no existe).
