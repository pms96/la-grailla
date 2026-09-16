import { describe, it, expect, afterEach } from 'vitest';
import { prisma } from '@/lib/prisma';
import { DEFAULT_SPONSOR_TIERS } from '@/lib/sponsor-tiers';

const { GET: getTiers } = await import('@/app/api/sponsors/tiers/route');

describe('GET /api/sponsors/tiers', () => {
  afterEach(async () => {
    await prisma.appConfig.deleteMany({ where: { key: 'sponsor_tiers' } });
  });

  it('devuelve los tipos por defecto si nadie ha guardado nada en Configuración', async () => {
    const res = await getTiers();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tiers).toEqual(DEFAULT_SPONSOR_TIERS);
  });

  // AUDIT: /admin/configuracion guarda los tipos como JSON bajo la clave
  // sponsor_tiers de AppConfig — este endpoint público es lo que consumen el
  // formulario de sponsors y el alta manual de admin, así que debe reflejar
  // exactamente lo último guardado ahí.
  it('devuelve los tipos guardados desde Configuración', async () => {
    const custom = [{ value: 'oro', label: 'Patrocinador Oro', priceLabel: '500€' }];
    await prisma.appConfig.create({ data: { key: 'sponsor_tiers', value: JSON.stringify(custom) } });

    const res = await getTiers();
    const data = await res.json();
    expect(data.tiers).toEqual(custom);
  });
});
