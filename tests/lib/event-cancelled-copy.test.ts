import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_CANCELLED_NOTICE, EVENT_CANCELLED_TITLE } from '@/lib/event-cancelled-copy';

describe('evento cancelado: textos públicos (H-099)', () => {
  it('no promete un aviso por email (puede no haberse enviado) y dice qué hacer', () => {
    expect(EVENT_CANCELLED_NOTICE).not.toMatch(/recibe un aviso/i);
    expect(EVENT_CANCELLED_NOTICE).toMatch(/ya no se venden entradas/);
    expect(EVENT_CANCELLED_NOTICE).toMatch(/referencia/);
    expect(EVENT_CANCELLED_TITLE).toBe('Este evento se ha cancelado');
  });

  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('la ficha usa el texto compartido y ya no promete el aviso', () => {
    const src = read('app/(public)/eventos/[slug]/page.tsx');
    expect(src).toContain('EVENT_CANCELLED_NOTICE');
    expect(src).not.toContain('Quien ya compró recibe un aviso');
  });

  it('`/comprar` de un evento cancelado enseña el aviso en lugar de un 404 genérico; un borrador sigue sin existir', () => {
    const src = read('app/(public)/eventos/[slug]/comprar/page.tsx');
    expect(src).toContain("event?.status === 'CANCELLED'");
    expect(src).toContain('EVENT_CANCELLED_NOTICE');
    expect(src).toMatch(/event\?\.status !== 'PUBLISHED'\) notFound\(\)/);
    // el aviso de cancelado va ANTES del notFound de lo no publicado
    expect(src.indexOf("event?.status === 'CANCELLED'")).toBeLessThan(src.indexOf("event?.status !== 'PUBLISHED'"));
  });
});
