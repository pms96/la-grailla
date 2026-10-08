import type { MetadataRoute } from 'next';
import { getFallbackBaseUrl } from '@/lib/url';

export const dynamic = 'force-dynamic';

// Modo normal: NEXTAUTH_URL o el dominio de La Grailla (como siempre). Modo plataforma: el dominio del cliente.
const legacyBase = () => getFallbackBaseUrl() || 'https://www.lagrailla.es';

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
    sitemap: `${legacyBase()}/sitemap.xml`,
  };
}
