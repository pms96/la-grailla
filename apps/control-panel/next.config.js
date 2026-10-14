const path = require('path');

// Cabeceras para una herramienta interna de un solo operador: nada de
// incrustarla, nada de indexarla, nada de recursos de terceros.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'none'",
    ].join('; '),
  },
];

/** @type {import('next').NextConfig} */
module.exports = {
  // Permite compilar a otra carpeta (la comprobación del build en la CI, o una local) sin pisar la del servidor de desarrollo.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  experimental: {
    // @grailla/contracts vive fuera de esta carpeta (../../packages/contracts).
    externalDir: true,
    // «Migrar BD» lanza el CLI de Prisma y su motor de esquema como proceso hijo y lee las migraciones del front. Se cargan por ruta en
    // tiempo de ejecución: el rastreo automático no las ve. scripts/bundle-migration-assets.js las copia a carpetas de la propia app
    // (`front-prisma/` y `migration-engine/`) porque en Vercel `node_modules/prisma` no llegaba a la función aunque se incluyera a mano.
    // Dos rutas lo necesitan: la ficha del cliente (Migrar BD) y el asistente de alta (que migra la BD recién creada).
    outputFileTracingIncludes: {
      '/tenants/[id]': ['./front-prisma/**/*', './migration-engine/**/*'],
      '/tenants/new': ['./front-prisma/**/*', './migration-engine/**/*'],
    },
  },
  webpack(config) {
    // El paquete de contratos importa zod desde fuera de esta app: se fuerza el de aquí
    // para que el despliegue con "Root Directory = apps/control-panel" no necesite un node_modules en la raíz.
    config.resolve.alias.zod = path.join(__dirname, 'node_modules/zod');
    return config;
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
