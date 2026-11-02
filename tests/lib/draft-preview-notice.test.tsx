import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DraftPreviewNotice } from '@/components/draft-preview-notice';

/* H-167 (fase 4): el ADMIN con Entradas ve la ficha de un borrador (H-059), pero nada le decía que era un borrador: se parecía a la ficha publicada y el público, mientras
 * tanto, recibe un 404. */

describe('H-167: aviso de vista previa de un borrador', () => {
  const html = renderToStaticMarkup(DraftPreviewNotice() as unknown as Parameters<typeof renderToStaticMarkup>[0]);

  it('dice que es un borrador, que solo lo ve el administrador y que el público recibe un 404', () => {
    expect(html).toContain('Borrador');
    expect(html).toMatch(/solo lo ves tú|solo lo ven los administradores/i);
    expect(html).toContain('404');
    expect(html).toContain('role="note"');
  });

  it('la ficha lo pinta solo para eventos en borrador', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../app/(public)/eventos/[slug]/page.tsx'), 'utf8');
    expect(page).toMatch(/event\.status === 'DRAFT' && <DraftPreviewNotice \/>/);
  });
});
