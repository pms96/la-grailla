import { describe, expect, it } from 'vitest';
import { descripcionContabilidad, nombreTemporadaPorDefecto } from '@/lib/compras/constantes';

/* P0-10: los textos de Contabilidad que eran de La Grailla («caseta», «Feria de Septiembre») son suyos; el resto de clientes recibe valores neutros. */

const LEAK = /caseta|feria/i;

describe('nombre de temporada por defecto', () => {
  it('La Grailla conserva «Feria de Septiembre {año}»', () => {
    expect(nombreTemporadaPorDefecto(true, 2026)).toBe('Feria de Septiembre 2026');
  });

  it('el resto de clientes parte de «Temporada {año}»', () => {
    expect(nombreTemporadaPorDefecto(false, 2026)).toBe('Temporada 2026');
    expect(nombreTemporadaPorDefecto(false)).toBe(`Temporada ${new Date().getFullYear()}`);
  });
});

describe('descripción de las pantallas de Contabilidad', () => {
  it('La Grailla conserva sus textos de siempre', () => {
    expect(descripcionContabilidad('compras', true)).toBe('Catálogo, comparativa de precios y pedidos de la caseta');
    expect(descripcionContabilidad('gastos', true)).toBe('Contabilidad real de la caseta por temporada');
    expect(descripcionContabilidad('ingresos', true)).toBe('Caja física de la caseta, día a día, por temporada');
  });

  it('el resto de clientes no ve «caseta» ni «feria»', () => {
    for (const s of ['compras', 'gastos', 'ingresos'] as const) {
      const t = descripcionContabilidad(s, false);
      expect(t).toBeTruthy();
      expect(t).not.toMatch(LEAK);
    }
  });
});

describe('prompt de la IA al importar listados de precios', () => {
  it('La Grailla conserva el suyo (proveedores de bebidas de una caseta de feria)', async () => {
    const { articulosMetaPrompt, ABACUS_ARTICULOS_META_PROMPT } = await import('@/lib/abacus-ai-adapter');
    expect(articulosMetaPrompt(true)).toBe(ABACUS_ARTICULOS_META_PROMPT);
    expect(ABACUS_ARTICULOS_META_PROMPT).toContain('Eres un asistente que digitaliza listados de precios de proveedores de bebidas para una caseta de feria. A partir de la imagen adjunta');
  });

  it('otro cliente recibe uno sin vertical y con el mismo formato de respuesta', async () => {
    const { articulosMetaPrompt, ABACUS_ARTICULOS_META_PROMPT } = await import('@/lib/abacus-ai-adapter');
    const neutro = articulosMetaPrompt(false);
    expect(neutro).not.toMatch(LEAK);
    expect(neutro).not.toContain('%%CONTEXTO%%');
    // Solo cambia la primera frase: las instrucciones y el JSON de salida son los mismos.
    expect(neutro.slice(neutro.indexOf('. A partir de la imagen'))).toBe(ABACUS_ARTICULOS_META_PROMPT.slice(ABACUS_ARTICULOS_META_PROMPT.indexOf('. A partir de la imagen')));
  });
});
