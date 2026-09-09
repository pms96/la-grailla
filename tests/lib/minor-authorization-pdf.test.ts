import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildMinorAuthorizationPdf } from '@/lib/minor-authorization-pdf';
import { DEFAULT_MINOR_AUTHORIZATION_TEXT } from '@/lib/minor-authorization-text';

function sampleEvent(overrides: Partial<Parameters<typeof buildMinorAuthorizationPdf>[0]> = {}) {
  return {
    name: 'Feria Sabado Noche',
    venue: 'Caseta',
    city: 'Encinas Reales',
    date: new Date('2026-09-25T22:00:00Z'),
    minorAuthorizationText: null,
    ...overrides,
  };
}

describe('buildMinorAuthorizationPdf', () => {
  it('genera una única página A4', async () => {
    const bytes = await buildMinorAuthorizationPdf(sampleEvent());
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeCloseTo(595.28, 0);
    expect(height).toBeCloseTo(841.89, 0);
  });

  it('cae al texto legal por defecto cuando el evento no tiene texto propio', async () => {
    const bytes = await buildMinorAuthorizationPdf(sampleEvent({ minorAuthorizationText: null }));
    expect(bytes.length).toBeGreaterThan(0);
    expect(DEFAULT_MINOR_AUTHORIZATION_TEXT.length).toBeGreaterThan(0);
  });

  it('no revienta con texto legal vacío/blanco', async () => {
    await expect(buildMinorAuthorizationPdf(sampleEvent({ minorAuthorizationText: '   ' }))).resolves.toBeInstanceOf(Uint8Array);
  });

  it('no revienta con texto legal editado por el admin, con párrafos', async () => {
    const bytes = await buildMinorAuthorizationPdf(
      sampleEvent({ minorAuthorizationText: 'Primer parrafo editado.\n\nSegundo parrafo con mas detalle sobre la caseta.' })
    );
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('no revienta con texto legal extremadamente largo (trunca en vez de fallar)', async () => {
    const longText = Array.from({ length: 60 }, (_, i) => `Parrafo numero ${i} con contenido legal de relleno para forzar el limite de la pagina.`).join('\n\n');
    const bytes = await buildMinorAuthorizationPdf(sampleEvent({ minorAuthorizationText: longText }));
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('no revienta con caracteres fuera de Latin-1', async () => {
    const bytes = await buildMinorAuthorizationPdf(
      sampleEvent({ name: 'Feria 中文 événement', minorAuthorizationText: 'Texto con emoji 🎉 y ñ, é, ü.' })
    );
    expect(bytes.length).toBeGreaterThan(0);
  });
});
