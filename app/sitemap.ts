import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/prisma';

const BASE = process.env.NEXTAUTH_URL?.replace(/\/$/, '') || 'https://www.lagrailla.es';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${BASE}/eventos`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE}/tienda`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE}/sponsors`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE}/legal/aviso-legal`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${BASE}/legal/privacidad`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${BASE}/legal/cookies`, changeFrequency: 'yearly', priority: 0.2 },
  ];

  try {
    const events = await prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      select: { slug: true, updatedAt: true },
      orderBy: { date: 'asc' },
    });
    const eventRoutes: MetadataRoute.Sitemap = events.map((e) => ({
      url: `${BASE}/eventos/${e.slug}`,
      lastModified: e.updatedAt,
      changeFrequency: 'daily',
      priority: 0.8,
    }));
    return [...staticRoutes, ...eventRoutes];
  } catch {
    return staticRoutes;
  }
}
