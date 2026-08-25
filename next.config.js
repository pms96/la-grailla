/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: process.env.NEXT_OUTPUT_MODE,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  images: { unoptimized: true },
  async redirects() {
    return [
      { source: '/patrocinio', destination: '/sponsors', permanent: true },
      { source: '/patrocinio/:path*', destination: '/sponsors', permanent: true },
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
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: blob: https://*.public.blob.vercel-storage.com`,
      `font-src 'self' data:`,
      `connect-src 'self'`,
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
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
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
    return config;
  },
};

module.exports = nextConfig;
