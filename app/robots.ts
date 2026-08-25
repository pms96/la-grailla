import type { MetadataRoute } from 'next';

const BASE = process.env.NEXTAUTH_URL?.replace(/\/$/, '') || 'https://www.lagrailla.es';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/admin/',
          '/acceso',
          '/acceso/',
          '/auth',
          '/auth/',
          '/api/',
          '/confirmacion/',
          '/tienda/checkout',
          '/tienda/confirmacion/',
        ],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
  };
}
