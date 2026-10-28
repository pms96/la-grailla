const fs = require('fs');
const path = require('path');

try {
  fs.copyFileSync(
    path.join(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
    path.join(__dirname, 'public/pdf.worker.min.mjs')
  );
} catch (err) {
  console.warn('No se pudo copiar pdf.worker.min.mjs:', err instanceof Error ? err.message : err);
}

/** Última migración de `prisma/migrations` que conoce ESTE build (la lee /api/health como «esquema esperado»). */
function latestMigration() {
  try {
    const dir = path.join(__dirname, 'prisma/migrations');
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return names[names.length - 1] || '';
  } catch {
    return '';
  }
}

/**
 * Optimización de imágenes de Vercel Blob (docs/platform/optimizacion-imagenes.md). Solo se activa si existe la variable NO secreta
 * BLOB_PUBLIC_HOST con el hostname exacto del store de la plataforma (`<id>.public.blob.vercel-storage.com`) y IMAGES_UNOPTIMIZED no vale 1.
 * Sin ella (o con un valor que no tenga esa forma) todo queda como antes: `images.unoptimized`. Nunca `domains` ni comodines.
 * La expresión regular se repite en lib/images/blob-image.ts (este fichero es CommonJS y no puede importar TypeScript).
 */
const BLOB_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.public\.blob\.vercel-storage\.com$/;
function blobPublicHost() {
  const raw = (process.env.BLOB_PUBLIC_HOST || '').trim().toLowerCase();
  if (!raw) return '';
  if (!BLOB_HOST_RE.test(raw)) {
    console.warn('BLOB_PUBLIC_HOST no tiene la forma <id>.public.blob.vercel-storage.com (solo el hostname, sin https:// ni barras): imágenes sin optimizar.');
    return '';
  }
  return raw;
}
const imagesOff = process.env.IMAGES_UNOPTIMIZED === '1';
const blobHost = imagesOff ? '' : blobPublicHost();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Con Next 15 los metadatos de una página con `generateMetadata` asíncrona (la ficha de evento consulta la BD) se mandan en streaming a
  // los navegadores: título, descripción, canonical y og:* acaban al final del <body>. El CDN cachea una sola variante por URL sin mirar el
  // User-Agent, así que a Googlebot le llegó la de un navegador. Este patrón trata a TODO agente como «limitado»: los metadatos se resuelven
  // antes de enviar el HTML y van siempre en el <head>, igual para todos y cacheables sin riesgo.
  htmlLimitedBots: /.*/,
  // BLOB_PUBLIC_HOST e IMAGES_UNOPTIMIZED no son secretos: se fijan en el build y llegan al servidor y al navegador (lib/images/blob-image.ts).
  env: { FRONT_SCHEMA_EXPECTED: latestMigration(), BLOB_PUBLIC_HOST: blobHost, IMAGES_UNOPTIMIZED: imagesOff ? '1' : '' },
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: process.env.NEXT_OUTPUT_MODE,
  poweredByHeader: false,
  // Sentry (P0-07) solo en el servidor y solo con SENTRY_DSN (instrumentation.ts). Sin esto webpack empaquetaría el SDK DOS veces (una para instrumentation.ts y
  // otra para el import dinámico de lib/observability/capture.ts: ~3,2 MB de servidor y dos instancias); como externo se carga de node_modules, una sola vez y
  // solo cuando alguien lo importa. No afecta al navegador ni al middleware.
  serverExternalPackages: ['@sentry/nextjs'],
  productionBrowserSourceMaps: false,
  typescript: {
    ignoreBuildErrors: false,
  },
  images: blobHost
    ? {
        // Solo WebP: menos variantes por imagen y menos CPU en la primera visita. AVIF = añadir 'image/avif' aquí (un cambio de una línea).
        formats: ['image/webp'],
        // El origen mide como mucho 1600 px (la subida lo reduce en el navegador).
        deviceSizes: [640, 828, 1200, 1600],
        imageSizes: [96, 256, 384],
        qualities: [75],
        // 31 días: las URLs llevan un UUID y no se reescriben.
        minimumCacheTTL: 2678400,
        remotePatterns: [{ protocol: 'https', hostname: blobHost, port: '', pathname: '/**', search: '' }],
      }
    : { unoptimized: true },
  async redirects() {
    return [
      { source: '/patrocinio', destination: '/sponsors', permanent: true },
      { source: '/patrocinio/:path*', destination: '/sponsors', permanent: true },
      // El portal del sponsor vivía en español; los enlaces con token ya
      // enviados por email siguen siendo válidos indefinidamente — Next.js
      // preserva automáticamente el ?t=... al redirigir.
      { source: '/patrocinadores/portal/:sponsorId', destination: '/sponsors/portal/:sponsorId', permanent: true },
      // La pantalla admin de pipeline se fusionó dentro de /admin/sponsors.
      { source: '/admin/sponsors-portal', destination: '/admin/sponsors', permanent: false },
    ];
  },
  async headers() {
    // 'unsafe-inline' en script-src es necesario porque Next.js App Router
    // inyecta el payload de RSC en <script> inline con contenido distinto en
    // cada petición (self.__next_f.push(...)) — no se puede fijar con hash, y
    // usar nonce exigiría desactivar el revalidate/ISR de las páginas
    // públicas (headers() por petición fuerza render dinámico), justo lo que
    // más importa mantener rápido en una web de venta de entradas. El resto
    // de directivas sí quedan cerradas: nada de scripts/objetos/frames
    // externos salvo los que el sitio usa de verdad (imágenes de Vercel
    // Blob, mapa embebido de Google, y el captcha Turnstile de Cloudflare, que solo se carga si el cliente lo activa).
    // next dev usa eval() para el Fast Refresh/HMR de webpack — no aplica a
    // production build, así que 'unsafe-eval' solo se permite en desarrollo.
    const isDev = process.env.NODE_ENV !== 'production';
    const csp = [
      `default-src 'self'`,
      `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${isDev ? " 'unsafe-eval'" : ''}`,
      `worker-src 'self' blob:`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: blob: https://*.public.blob.vercel-storage.com`,
      // El vídeo final y los vídeos de referencia del sponsor se sirven
      // desde Vercel Blob, igual que las imágenes de arriba.
      `media-src 'self' https://*.public.blob.vercel-storage.com`,
      `font-src 'self' data:`,
      // La subida de archivos del sponsor/admin va DIRECTA del navegador a
      // Vercel Blob (@vercel/blob/client) para no chocar con el límite de
      // payload de las funciones serverless. El SDK sube el binario a través
      // de https://vercel.com/api/blob (no directamente al dominio de
      // *.public.blob.vercel-storage.com, que solo sirve lecturas) — sin
      // ambos orígenes aquí, el PUT del navegador lo bloquea la CSP.
      `connect-src 'self' https://vercel.com https://*.public.blob.vercel-storage.com https://challenges.cloudflare.com`,
      `frame-src https://www.google.com https://maps.google.com https://challenges.cloudflare.com`,
      `object-src 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
      `frame-ancestors 'none'`,
      `upgrade-insecure-requests`,
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), bluetooth=(self)' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
      // Páginas públicas: antes se cacheaban con ISR (`revalidate = 60`), que cachea por RUTA y no por Host; con varios
      // clientes en un mismo despliegue eso mezclaría sus páginas. Ahora son dinámicas y las cachea el CDN de Vercel (cuya
      // clave de caché incluye el dominio). Solo afecta al CDN: el navegador no las guarda.
      ...['/', '/eventos', '/eventos/:slug', '/tienda', '/sponsors', '/legal/:path*'].map((source) => ({
        source,
        headers: [{ key: 'Vercel-CDN-Cache-Control', value: 'max-age=60, stale-while-revalidate=30' }],
      })),
      // Ficheros de marca (logo, pegatinas, banda del wallet). Sin hash en el nombre y reemplazables, así que nada de
      // `immutable` ni caducidades de un año: 1 día fresco y hasta 7 días sirviendo la copia vieja mientras se revalida
      // en segundo plano. Sin esto Next los sirve con max-age=0.
      {
        source: '/brand/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.output.filename = 'static/chunks/[name]-[contenthash:8].js';
      config.output.chunkFilename = 'static/chunks/[contenthash:16].js';
    }
    config.resolve.alias.canvas = false;
    return config;
  },
};

module.exports = nextConfig;
