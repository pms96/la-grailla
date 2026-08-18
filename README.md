# La Grailla

Plataforma de venta de entradas y gestión operativa para los eventos de La Grailla (caseta de feria / fiestas). Sirve dos públicos: la web pública de compra de entradas y merch, y el panel de administración para gestionar eventos, aforo, pedidos, taquilla y control de acceso por QR.

Ver [PRODUCT.md](PRODUCT.md) para el contexto de producto completo, [DESIGN.md](DESIGN.md) para el sistema de diseño y [STYLE_GUIDE.md](STYLE_GUIDE.md) para convenciones de código.

## Stack

- Next.js 14 (App Router) + TypeScript
- PostgreSQL + Prisma
- NextAuth (credenciales)
- Tailwind CSS + shadcn/ui (Radix)
- Stripe / SumUp (pasarelas de pago, intercambiables vía `lib/payment-adapter.ts`)
- Vitest (tests)

## Requisitos previos

- Node.js 20+
- Docker (para levantar Postgres en local) — o una URL de Postgres ya existente

## Puesta en marcha

```bash
npm install
cp .env.example .env
```

Rellena `.env`:
- `NEXTAUTH_SECRET`: genera uno con `openssl rand -base64 32`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`: credenciales del admin que se crea al sembrar la BD
- `DATABASE_URL` / `DIRECT_URL`: el valor de ejemplo apunta a la Postgres local de `docker-compose.yml`. **En producción con Vercel + Neon**, `DATABASE_URL` debe ser la connection string con `-pooler` (obligatoria en serverless — sin pool, un pico de tráfico agota las conexiones de Postgres) y `DIRECT_URL` la misma sin poolear (la necesitan `prisma migrate`/`db push`)

Levanta la base de datos local, aplica el esquema y siembra datos de ejemplo (admin, configuración por defecto, un evento y unos tipos de entrada):

```bash
docker compose up -d
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

La app queda en `http://localhost:3000`. Entra en `/auth/login` con `ADMIN_EMAIL`/`ADMIN_PASSWORD` para acceder al panel en `/admin`.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción |
| `npm start` | Sirve el build de producción |
| `npm run lint` | ESLint |
| `npm test` | Tests (Vitest) |
| `npx prisma db seed` | Vuelve a sembrar admin + config + datos de ejemplo (usa `scripts/safe-seed.ts`, que aborta si `scripts/seed.ts` contiene `delete`/`deleteMany`, para no poder borrar datos de producción por accidente). ⚠️ Reejecutarlo **sobrescribe la contraseña del admin** con el `ADMIN_PASSWORD` que haya en `.env` en ese momento — no lo relances contra una BD compartida/producción con un `.env` desactualizado |
| `npx prisma studio` | Explorador visual de la base de datos |

## Configuración en tiempo de ejecución

Las credenciales de pasarela de pago (Stripe/SumUp), SMTP y wallets (Apple/Google) **no van en `.env`** — se gestionan desde `/admin/configuracion` una vez la app está en marcha, y se guardan en la tabla `AppConfig`. Las credenciales sensibles (`stripe_secret_key`, `stripe_webhook_secret`, `sumup_api_key`) se cifran en reposo con AES-256-GCM antes de guardarse (ver `lib/secrets.ts`); la clave de cifrado se deriva de `NEXTAUTH_SECRET`, así que si rotas ese secreto tendrás que volver a introducir esas credenciales.

### Webhook de Stripe

Para que los pedidos se confirmen aunque el comprador no vuelva a la página de confirmación (fallo de red, cierre de pestaña, métodos de pago asíncronos), la app expone `POST /api/webhooks/stripe`. En el Dashboard de Stripe, crea un endpoint apuntando a `https://tu-dominio/api/webhooks/stripe` escuchando:
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

Copia el "Signing secret" que te da Stripe al crearlo y pégalo en `/admin/configuracion` → pestaña Pagos → *Stripe Webhook Secret*.

## Tests

```bash
npm test
```

Cubren el flujo de checkout: creación de pedidos (`tests/api/orders.test.ts`) y confirmación de pago vía webhook (`tests/api/webhooks-stripe.test.ts`). Corren contra la base de datos configurada en `DATABASE_URL` (sin mocks de Prisma) — usan eventos de prueba con prefijo `[TEST]` y limpian todo lo que crean al terminar, incluida la configuración temporal que puedan tocar (pasarela, comisión, claves de Stripe de prueba).

## Test de carga

Antes de una venta de entradas con pico de tráfico esperado, ejecuta el test de carga en `loadtest/` (requiere [k6](https://k6.io)) — comprueba que no haya sobreventa bajo compra concurrente y mide latencia/errores bajo tráfico sostenido. Ver [loadtest/README.md](loadtest/README.md).

## Estructura

```
app/
├── (public)/       # Web pública: eventos, checkout, tienda, sponsors
├── admin/          # Panel de administración
├── acceso/         # Taquilla / control de acceso por QR
├── auth/           # Login
└── api/            # Route handlers (orders, webhooks, scan, wallet, admin...)
lib/                # Lógica compartida: pagos, config, email, QR, secretos...
prisma/schema.prisma
tests/
```
