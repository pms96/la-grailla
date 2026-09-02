import { describe, it, expect, vi, beforeAll } from 'vitest';

const createMock = vi.fn();

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: createMock } };
  },
}));

// La BD de dev compartida puede tener una API key real de Abacus.AI
// configurada (para probar el flujo de verdad) — este test no debe depender
// de ese estado ambiental, así que fuerza "sin configurar" explícitamente.
vi.mock('@/lib/config', () => ({ getConfig: vi.fn(async () => '') }));

describe('AbacusAIAdapter.generateVideoPrompt', () => {
  beforeAll(() => {
    if (!process.env.NEXTAUTH_SECRET) {
      process.env.NEXTAUTH_SECRET = 'test-secret-for-abacus-adapter-vitest';
    }
  });

  // AUDIT: los modelos de chat suelen envolver el JSON pedido en fences de
  // markdown (```json ... ```) pese a la instrucción de "sin texto
  // adicional" — el parseo debe seguir extrayendo el prompt igualmente.
  it('extrae prompt_es/prompt_en aunque vengan envueltos en un bloque de código', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: '```json\n{"prompt_es": "Vídeo en español", "prompt_en": "Video in English"}\n```' } }],
    });

    const { AbacusAIAdapter } = await import('@/lib/abacus-ai-adapter');
    const adapter = new AbacusAIAdapter('fake-key');
    const result = await adapter.generateVideoPrompt({
      logoUrl: 'https://example.com/logo.png',
      guidedAnswers: { estiloVisual: 'minimalista' },
      freeText: 'algo elegante',
    });

    expect(result.promptEs).toBe('Vídeo en español');
    expect(result.promptEn).toBe('Video in English');

    // Contrato confirmado por Abacus.AI: RouteLLM, modelo fijo "route-llm".
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'route-llm', stream: false })
    );
  });

  it('lanza un error claro si la respuesta no trae JSON parseable', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: 'lo siento, no puedo ayudar con eso' } }] });

    const { AbacusAIAdapter } = await import('@/lib/abacus-ai-adapter');
    const adapter = new AbacusAIAdapter('fake-key');
    await expect(
      adapter.generateVideoPrompt({ logoUrl: 'https://example.com/logo.png', guidedAnswers: {}, freeText: '' })
    ).rejects.toThrow(/JSON/);
  });
});

describe('getAbacusAIProvider', () => {
  it('cae al mock cuando no hay API key configurada', async () => {
    const { getAbacusAIProvider, MockAbacusAIAdapter } = await import('@/lib/abacus-ai-adapter');
    const provider = await getAbacusAIProvider();
    expect(provider).toBeInstanceOf(MockAbacusAIAdapter);
  });
});

describe('AbacusAIAdapter.extractArticulosFromImage', () => {
  beforeAll(() => {
    if (!process.env.NEXTAUTH_SECRET) {
      process.env.NEXTAUTH_SECRET = 'test-secret-for-abacus-adapter-vitest';
    }
  });

  it('extrae los artículos de la imagen y normaliza categoría/precio/unidad mínima', async () => {
    createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              items: [
                { nombre: 'Cruzcampo 1/3', categoria: 'Cervezas', formato: 'Botella 1/3', formatoVenta: 'Caja 24', precioSinIva: '0.534', unidadMinPedido: '24' },
                // categoría inventada por el modelo -> debe caer a 'Otros'; sin formatoVenta -> 'Unidad'
                { nombre: 'Producto raro', categoria: 'Lácteos', formato: 'Botella 1L', precioSinIva: 1.2 },
              ],
            }),
          },
        },
      ],
    });

    const { AbacusAIAdapter } = await import('@/lib/abacus-ai-adapter');
    const adapter = new AbacusAIAdapter('fake-key');
    const { items } = await adapter.extractArticulosFromImage({ imageUrl: 'https://example.com/lista.jpg' });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ nombre: 'Cruzcampo 1/3', categoria: 'Cervezas', precioSinIva: 0.53, unidadMinPedido: 24 });
    expect(items[1]).toMatchObject({ nombre: 'Producto raro', categoria: 'Otros', formatoVenta: 'Unidad', unidadMinPedido: 1 });
  });

  it('devuelve una lista vacía si la imagen no tiene artículos legibles', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: '{"items":[]}' } }] });

    const { AbacusAIAdapter } = await import('@/lib/abacus-ai-adapter');
    const adapter = new AbacusAIAdapter('fake-key');
    const { items } = await adapter.extractArticulosFromImage({ imageUrl: 'https://example.com/lista.jpg' });
    expect(items).toEqual([]);
  });

  it('lanza un error claro si la respuesta no trae JSON parseable', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: 'no puedo leer la imagen' } }] });

    const { AbacusAIAdapter } = await import('@/lib/abacus-ai-adapter');
    const adapter = new AbacusAIAdapter('fake-key');
    await expect(
      adapter.extractArticulosFromImage({ imageUrl: 'https://example.com/lista.jpg' })
    ).rejects.toThrow(/JSON/);
  });
});
