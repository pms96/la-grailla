# Optimización de imágenes del sitio público

Las fotos que suben los clientes (carteles, productos, miniaturas, secciones) viven en Vercel Blob y hoy se descargan tal cual, en su tamaño original (hasta 1600 px, ~300 KB) aunque se pinten a 56 px. Con la optimización activa el navegador pide a `/_next/image` una variante en WebP del ancho que necesita. **Viene apagada**: sin la variable de abajo todo funciona exactamente como antes.

## Cómo funciona

- `lib/images/blob-image.ts` expone `blobImgProps(url, { sizes })`. Se usa dentro del mismo `<img>` de siempre (`<img {...blobImgProps(url, { sizes })} alt="" className="…" />`): mismas clases, mismo maquetado, sin `fill` ni `width`/`height` nuevos. Solo añade `src`, `srcset` y `sizes`.
- Solo optimiza una URL si es **https**, su hostname es **exactamente** el de `BLOB_PUBLIC_HOST`, no lleva puerto, credenciales, `?` ni `#`. Cualquier otra (otro store de Blob, `http:`, una URL externa escrita a mano, ruta relativa, `data:`, `blob:`, `host.evil.com`…) se queda con su `src` original y no pasa por el optimizador.
- `next.config.js` solo configura el optimizador si existe `BLOB_PUBLIC_HOST` con la forma `<id>.public.blob.vercel-storage.com` y `IMAGES_UNOPTIMIZED` no vale `1`. Si falta o está mal formada, deja `images.unoptimized: true` (si está mal formada, avisa en el log del build). `remotePatterns` lleva ese host exacto (https, sin puerto, `pathname: '/**'`, `search: ''`); nunca `domains` ni comodines.
- Las dos variables se leen **en el build** (`env` de `next.config.js`): servidor y navegador deciden igual. No son secretas. Cualquier cambio exige un nuevo despliegue.

Configuración de `images` cuando está activa: `formats: ['image/webp']`, `deviceSizes: [640, 828, 1200, 1600]`, `imageSizes: [96, 256, 384]`, `qualities: [75]`, `minimumCacheTTL: 2678400` (31 días; las URLs llevan UUID y no se reescriben).

## Activarla

1. Averigua el hostname del store (sin tocar secretos): abre en la web pública una imagen subida por un cliente, copia su dirección y quédate con el hostname, `<id>.public.blob.vercel-storage.com`. (También sale en Vercel → Storage → el store → URL base. No uses ni copies el `BLOB_READ_WRITE_TOKEN`.)
2. En Vercel, proyecto de la plataforma (`grailla-platform`; y el antiguo `la-grailla` si se quiere), Settings → Environment Variables: crea `BLOB_PUBLIC_HOST` con ese hostname (solo el hostname: sin `https://` ni barras) para Production (y Preview si quieres comprobar el build). No es secreta.
3. Redespliega (la variable se fija en el build). Comprueba que Settings → Image Optimization no está desactivado.
4. Comprobación: en una portada con cartel, el `<img>` lleva `srcset="/_next/image?url=…&w=…&q=75 …"`; abre una de esas URLs y debe responder `200` con `image/webp`. Una `url` de otro host debe dar `400` (`"url" parameter is not allowed`).

## Volver atrás

- Rápido: pon `IMAGES_UNOPTIMIZED=1` (o borra `BLOB_PUBLIC_HOST`) y redespliega, o «Instant Rollback» al despliegue anterior. Las páginas vuelven a servir el `src` original de Blob; no queda nada que deshacer en datos.

## Coste estimado

Vercel Pro, transformaciones de imagen por uso (sin cupo propio; lo cubre el crédito de 20 $/mes de la cuota de plataforma). Con 15 clientes y hasta 50.000 visitas al mes por cliente, la estimación es **menos de 4 $/mes** (casi todo es lectura de caché, no transformación: ~4.800 transformaciones ≈ 0,4 $). Supuestos y tarifas en el informe de origen (2026-10-26); no confirmado el efecto sobre el ancho de banda del CDN. Conviene fijar una alerta en Spend Management.

## Por qué solo WebP

Cada formato multiplica las variantes por imagen y ancho, y la primera visita las genera (CPU y latencia del primer visitante). WebP da la mayor parte del ahorro. AVIF es un cambio de una línea (`formats: ['image/avif', 'image/webp']` en `next.config.js`) si el gasto lo permite.

## Qué NO se optimiza (a propósito)

- Logos `/brand/*` (`components/logo.tsx`): son estáticos que ya se sirven con caché y se muestran a ~50 px desde un PNG de 1200 px; el optimizador pediría anchos enormes. Van con `unoptimized` y el mismo aspecto.
- Miniaturas del carrito (`drop-cart.tsx`, `shop-checkout-client.tsx`, la lista del carrito de `shop-grid.tsx`): 64 px, ya descargadas en la tienda.
- Logos de Blob de la marca (`<img>` de `Logo`), `sponsor-asset-list` y todo el panel `/admin`.
- Emails, PDF/QR, Google Wallet, Open Graph y JSON-LD: usan la URL original de Blob (necesitan una URL absoluta y estable, no una variante del optimizador).
- Imágenes de un store distinto, `http:`, URLs externas escritas a mano y cualquier URL con `?` o `#`.
- El middleware: su `matcher` ya excluye `_next/image`, así que el optimizador no resuelve cliente ni aplica licencia o suspensión (las URLs de Blob ya eran públicas).

## Purgar una imagen borrada

Una imagen borrada de Blob puede seguir en la caché del optimizador hasta 31 días. Para purgarla: `vercel cache invalidate --srcimg <URL original de Blob>` (o `invalidateBySrcImage()` del SDK de Vercel). Hacerlo si el borrado es por motivos legales o de privacidad.

## Cómo se probó

Tests: `tests/lib/blob-image.test.ts` (host exacto, otro store, `http:`, subdominios engañosos, sin variable, `IMAGES_UNOPTIMIZED`, relativas, `data:`) y los de render de cada plantilla, con y sin la variable. Build en local con y sin `BLOB_PUBLIC_HOST` y `next start`: sin ella `images-manifest.json` queda `unoptimized: true` y el HTML conserva el `src` original; con ella solo las URLs del host exacto llevan `srcset`, y `/_next/image` responde `400` a otro host, `http:`, `host.evil.com`, una `url` con query, un ancho (`w`) o calidad (`q`) fuera de lista. No se pudo probar de extremo a extremo con el store real de Blob (haría falta el hostname real).

Nota: `next start` en local también necesita `BLOB_PUBLIC_HOST` en el entorno al arrancar (sin ella `/_next/image` da 404); en Vercel basta con tenerla en el build.
