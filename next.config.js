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

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: process.env.NEXT_OUTPUT_MODE,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  typescript: {
    ignoreBuildErrors: false,
  },
  images: { unoptimized: true },
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
    // Blob, mapa embebido de Google).
    // next dev usa eval() para el Fast Refresh/HMR de webpack — no aplica a
    // production build, así que 'unsafe-eval' solo se permite en desarrollo.
    const isDev = process.env.NODE_ENV !== 'production';
    const csp = [
      `default-src 'self'`,
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      `worker-src 'self' blob:`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: blob: https://*.public.blob.vercel-storage.com`,
      // El vídeo final y los vídeos de referencia del sponsor se sirven
      // desde Vercel Blob, igual que las imágenes de arriba.
      `media-src 'self' https://*.public.blob.vercel-storage.com`,
      `font-src 'self' data:`,
      // La subida de archivos del sponsor/admin va DIRECTA del navegador a
      // Vercel Blob (@vercel/blob/client) para no chocar con el límite de
      // payload de las funciones serverless — sin este origen aquí, el PUT
      // del navegador a *.public.blob.vercel-storage.com lo bloquea la CSP.
      `connect-src 'self' https://*.public.blob.vercel-storage.com`,
      `frame-src https://www.google.com https://maps.google.com`,
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
