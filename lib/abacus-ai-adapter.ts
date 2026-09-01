/* Adaptador para Abacus.AI — mismo patrón que lib/payment-adapter.ts (interfaz +
 * implementación real + mock, credenciales vía getConfig()).
 *
 * Contrato confirmado: RouteLLM de Abacus.AI expone una API compatible con
 * OpenAI Chat Completions en https://routellm.abacus.ai/v1, modelo fijo
 * "route-llm" (el propio RouteLLM decide el modelo real por debajo). Se usa
 * el SDK oficial `openai` apuntando a esa base URL, igual que StripeAdapter
 * importa el SDK de Stripe de forma diferida (solo se carga si de verdad se usa).
 */
import { getConfig } from '@/lib/config';

export type GenerateVideoPromptInput = {
  logoUrl: string;
  guidedAnswers: Record<string, string>;
  freeText: string;
};

export type GenerateVideoPromptResult = {
  promptEs: string;
  promptEn: string;
  raw: unknown;
};

// Prompt de sistema enviado junto a la imagen del logo y el contexto creativo.
// Se le pide JSON estricto para poder parsear la respuesta sin ambigüedad.
export const ABACUS_META_PROMPT = `Eres un director creativo experto en vídeo publicitario para pantallas LED de eventos. A partir del logotipo adjunto y la descripción creativa proporcionada, genera un prompt profesional para una herramienta de vídeo generativo, en dos idiomas (español e inglés).

Requisitos técnicos obligatorios que el prompt debe incorporar explícitamente:
- Duración del vídeo: entre 12 y 17 segundos.
- Relación de aspecto adaptable a pantalla LED: 16:9 horizontal o 3:4 vertical.
- Sin audio — el vídeo es mudo, todo el impacto debe ser visual (contraste, movimiento, luz).
- Fidelidad de marca máxima: el logotipo debe conservarse exactamente como se ve en la imagen — no alterar su tipografía, no cambiar sus colores de marca, no inventar elementos tipográficos que no existan en el original. Se permiten revelaciones progresivas, transiciones cinemáticas y efectos de iluminación elegantes alrededor del logo, nunca alteraciones del logo en sí.

Devuelve exclusivamente un JSON con esta forma, sin texto adicional antes ni después:
{"prompt_es": "...", "prompt_en": "..."}`;

export interface AbacusAIProvider {
  generateVideoPrompt(input: GenerateVideoPromptInput): Promise<GenerateVideoPromptResult>;
}

function buildUserContext(input: GenerateVideoPromptInput): string {
  const answers = Object.entries(input.guidedAnswers)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
  return `Logo: ${input.logoUrl}\n\nRespuestas guiadas:\n${answers}\n\nDescripción libre:\n${input.freeText || '(sin descripción adicional)'}`;
}

// Los modelos de chat casi nunca respetan al 100% "sin texto adicional" — a
// veces envuelven el JSON en ```json ... ```. Se extrae el primer bloque
// {...} de la respuesta antes de parsear, en vez de asumir que el string
// completo ya es JSON puro.
function parseAbacusResponse(content: string | null | undefined): { promptEs: string; promptEn: string } {
  const text = content ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Abacus.AI no devolvió un JSON con prompt_es/prompt_en');
  }
  let parsed: { prompt_es?: string; prompt_en?: string };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error('Abacus.AI no devolvió un JSON válido con prompt_es/prompt_en');
  }
  if (!parsed.prompt_es || !parsed.prompt_en) {
    throw new Error('La respuesta de Abacus.AI no incluye prompt_es y prompt_en');
  }
  return { promptEs: parsed.prompt_es, promptEn: parsed.prompt_en };
}

export class AbacusAIAdapter implements AbacusAIProvider {
  constructor(private apiKey: string) {}

  async generateVideoPrompt(input: GenerateVideoPromptInput): Promise<GenerateVideoPromptResult> {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ baseURL: 'https://routellm.abacus.ai/v1', apiKey: this.apiKey });

    const completion = await client.chat.completions.create({
      model: 'route-llm',
      stream: false,
      messages: [
        { role: 'system', content: ABACUS_META_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildUserContext(input) },
            { type: 'image_url', image_url: { url: input.logoUrl } },
          ],
        },
      ],
    });

    const { promptEs, promptEn } = parseAbacusResponse(completion.choices[0]?.message?.content);
    return { promptEs, promptEn, raw: completion };
  }
}

export class MockAbacusAIAdapter implements AbacusAIProvider {
  async generateVideoPrompt(input: GenerateVideoPromptInput): Promise<GenerateVideoPromptResult> {
    const promptEs = `[MOCK] Vídeo cinemático de 15 segundos, mudo, revelando el logo de la marca con transiciones elegantes de luz, sin alterar tipografía ni colores. Contexto: ${input.freeText || 'sin descripción'}.`;
    const promptEn = `[MOCK] 15-second silent cinematic video revealing the brand logo with elegant light transitions, no typography or color changes. Context: ${input.freeText || 'no description'}.`;
    return { promptEs, promptEn, raw: { mock: true } };
  }
}

// A diferencia de los pagos (donde una pasarela mal configurada nunca debe
// simular un cobro aceptado), aquí el admin siempre revisa y edita el prompt
// a mano antes de aprobarlo — así que sin API key configurada se cae a un
// mock reconocible en vez de bloquear, útil para desarrollo/tests sin coste.
export async function getAbacusAIProvider(): Promise<AbacusAIProvider> {
  const apiKey = (await getConfig('abacus_ai_api_key')).trim();
  if (!apiKey) return new MockAbacusAIAdapter();
  return new AbacusAIAdapter(apiKey);
}
