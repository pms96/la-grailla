import { describe, expect, it } from 'vitest';
import { readConfigPayload } from '@/lib/config-client';

describe('readConfigPayload (H-096)', () => {
  it('una lista válida da sus filas', () => {
    expect(readConfigPayload(true, [{ key: 'a', value: '1' }, { key: 'b', value: '' }])).toEqual({ configs: [{ key: 'a', value: '1' }, { key: 'b', value: '' }] });
  });

  it('una lista vacía es válida (cliente nuevo), no un error', () => {
    expect(readConfigPayload(true, [])).toEqual({ configs: [] });
  });

  it('un {error} con 4xx/5xx es un error con su texto, no un formulario vacío', () => {
    expect(readConfigPayload(false, { error: 'No autorizado' })).toEqual({ error: 'No autorizado' });
    expect(readConfigPayload(false, { error: 'Ha ocurrido un error inesperado.', code: 'internal_server_error' })).toEqual({ error: 'Ha ocurrido un error inesperado.' });
  });

  it('una respuesta con estado de error es un error aunque el cuerpo sea una lista', () => {
    expect('error' in readConfigPayload(false, [{ key: 'a', value: '1' }])).toBe(true);
    expect('error' in readConfigPayload(false, [])).toBe(true);
  });

  it('un cuerpo que no es una lista (aunque el estado sea 200) también es un error', () => {
    expect('error' in readConfigPayload(true, { error: 'x' })).toBe(true);
    expect('error' in readConfigPayload(true, null)).toBe(true);
    expect('error' in readConfigPayload(true, 'html')).toBe(true);
  });

  it('sin texto de error usa uno genérico en español', () => {
    // H-167: la pantalla ya pone «No se ha podido cargar la configuración.» de título: el texto de debajo no puede repetirlo.
    const generic = 'El servidor no ha devuelto la configuración. Prueba de nuevo en un momento.';
    expect(readConfigPayload(false, null)).toEqual({ error: generic });
    expect(readConfigPayload(false, { error: 5 })).toEqual({ error: generic });
    expect(generic).not.toBe('No se ha podido cargar la configuración.');
  });

  it('descarta filas sin clave y normaliza valores que no son texto', () => {
    expect(readConfigPayload(true, [null, { value: 'x' }, { key: 'k', value: null }])).toEqual({ configs: [{ key: 'k', value: '' }] });
  });
});
